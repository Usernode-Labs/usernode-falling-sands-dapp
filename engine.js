/**
 * Falling-sands simulation engine.
 *
 * Runs the WASM universe server-side for snapshot generation and relays
 * transactions to connected clients via WebSocket. Clients run their own
 * local WASM simulation for rendering (see wasm-browser.js + index.html).
 *
 * Usage:
 *   const createEngine = require('./engine');
 *   const engine = createEngine({ wasmLoaderPath: './wasm-loader' });
 *   engine.attachWebSocket(httpServer);
 *   engine.startTickLoop();
 *   engine.addTransaction({ timestamp_ms, memo, from });
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { seedUniverse, WIDTH, HEIGHT, CELL_BYTES, FRAME_SIZE } = require("./seed-content");

const TICK_HZ = 30;
const TICK_INTERVAL_MS = 1000 / TICK_HZ;
const PING_INTERVAL = 20_000;

// Default epoch (Jan 1, 2026). Overridden per-engine by chain genesis time.
const DEFAULT_TICK_EPOCH = 1767225600000;

const SNAPSHOT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours (disk saves)
const CHECKPOINT_INTERVAL_TICKS = TICK_HZ * 5;    // every 5 seconds
const MAX_CHECKPOINTS = 24;

// Physics only runs for WINDOW_SECONDS after genesis or any draw transaction.
const WINDOW_SECONDS = 10 * 60;
const WINDOW_TICKS = WINDOW_SECONDS * TICK_HZ;

// Fixed delay added to block timestamp to derive the canonical draw tick.
// Covers the worst-case server pipeline (receive tx → WS broadcast →
// every client schedules it for the same future tick) so the draw lands
// slightly in the future relative to when the server first sees the tx.
// 5s is comfortable now that the node-stream fast path (USE_NODE_STREAM)
// delivers txs sub-second instead of the 5–60s explorer indexing lag.
// Bump back up if we see clients missing the drawTick (they'd rewind and
// replay, which is correct but expensive).
const PROCESSING_DELAY_MS = 5000;

function createEngine(opts) {
  const wasmLoaderPath = (opts && opts.wasmLoaderPath) || "./wasm-loader";
  const snapshotDir = (opts && opts.snapshotDir) || __dirname;
  const chainId = (opts && opts.chainId) || null;
  const explicitEpoch = opts && opts.epoch;
  const TICK_EPOCH = explicitEpoch || DEFAULT_TICK_EPOCH;
  // Persisting a snapshot is only safe when both chain_id and epoch are
  // real (caller-supplied). Otherwise the snapshot ends up tagged with
  // DEFAULT_TICK_EPOCH, which is permanently incompatible with any boot
  // that successfully discovers the real chain genesis — the same
  // "fallback poisoning" that just made us replay 220 draws from
  // genesis. When this is false the engine still runs (with the
  // fallback epoch) but never writes to disk; a subsequent boot with
  // proper chain info will start fresh and write the first good
  // snapshot.
  const canPersistSnapshots = !!(chainId && explicitEpoch);
  // Pubkey permitted to issue `{ app: "falling-sands", type: "reset" }`
  // memos. Any reset memo from a different sender is silently ignored
  // (both live and during historical replay), so only the configured
  // admin can wipe the shared canvas back to its seeded default.
  const adminPubkey = (opts && opts.adminPubkey) || null;

  function timestampToTick(ms) { return Math.floor((ms - TICK_EPOCH) / TICK_INTERVAL_MS); }
  function tickToTimestamp(tick) { return TICK_EPOCH + tick * TICK_INTERVAL_MS; }

  function computeDrawTick(tx) {
    const blockTs = (tx.inclusion_latency_ms != null)
      ? tx.timestamp_ms + tx.inclusion_latency_ms
      : tx.timestamp_ms;
    return timestampToTick(blockTs + PROCESSING_DELAY_MS);
  }

  const { Universe, Species, memory, prng } = require(wasmLoaderPath);

  const universe = Universe.new(WIDTH, HEIGHT);

  // Captured once so reseedUniverse() (the reset path) can reproduce the
  // same starting content as engine boot — source placements, cup walls,
  // flag bits. Must stay in sync with the initial seedUniverse call below.
  const seedOpts = {
    openBottom: process.env.FALLING_SANDS_OPEN_BOTTOM !== "false",
    sources: process.env.FALLING_SANDS_SOURCES !== "false",
    plantAbsorbs: process.env.FALLING_SANDS_PLANT_ABSORBS !== "false",
  };

  const { sourcesEnabled } = seedUniverse(universe, Species, memory, seedOpts);

  // Resets the universe back to its initial seeded content. Called when
  // an admin reset memo is applied (live or during replay). Wipes cells
  // (universe.reset), zeros the burns buffer (seedUniverse only handles
  // cells + winds), and re-runs the initial seeding so sources and
  // cup walls come back. Leaves prng / rng_state / generation where
  // they are — determinism across server + clients is maintained via the
  // captured snapshot broadcast, not by rewinding the PRNGs to genesis.
  function reseedUniverse() {
    universe.reset();
    const burnsPtr = universe.burns();
    new Uint8Array(memory.buffer, burnsPtr, FRAME_SIZE).fill(0);
    seedUniverse(universe, Species, memory, seedOpts);
  }

  // ── Tick state ──────────────────────────────────────────────────────────

  let tickCount = timestampToTick(Date.now());
  let ticksProcessed = 0;

  // ── Draw helpers ─────────────────────────────────────────────────────────

  function segmentToPoints(seg) {
    const [x1, y1, x2, y2, size] = seg;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(1, Math.floor(size * 0.6));
    const steps = Math.max(1, Math.ceil(dist / step));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      points.push({ x: Math.round(x1 + dx * t), y: Math.round(y1 + dy * t) });
    }
    return points;
  }

  function applyDrawMemo(memo, fromLabel) {
    if (memo.app !== "falling-sands" || memo.type !== "draw" || !Array.isArray(memo.s)) return false;
    for (const seg of memo.s) {
      if (!Array.isArray(seg) || seg.length < 6) continue;
      const species = seg[5] | 0;
      const size = Math.max(1, Math.min(20, seg[4] | 0));
      const pts = segmentToPoints(seg);
      for (const pt of pts) {
        const x = Math.max(0, Math.min(WIDTH - 1, pt.x | 0));
        const y = Math.max(0, Math.min(HEIGHT - 1, pt.y | 0));
        universe.paint(x, y, size, species);
      }
    }
    console.log(`[chain] applied drawing: ${memo.s.length} stroke(s) from ${fromLabel}`);
    return true;
  }

  // True iff this memo is an admin-authored reset command. Enforced at
  // the memo level — any sender that isn't the configured adminPubkey is
  // ignored (we still log so operators can see the attempt). Returning
  // false here means the caller should treat the memo as a no-op, same
  // as an unrecognised memo shape.
  function isAdminResetMemo(memo, fromPubkey) {
    if (!memo || memo.app !== "falling-sands" || memo.type !== "reset") return false;
    if (!adminPubkey) {
      console.warn(`[reset] ignoring reset memo from ${fromPubkey || "?"} — no SANDS_ADMIN_PUBKEY configured`);
      return false;
    }
    if (fromPubkey !== adminPubkey) {
      console.warn(`[reset] ignoring reset memo from ${(fromPubkey || "?").slice(0, 16)}… — not admin`);
      return false;
    }
    return true;
  }

  // ── Mock transaction draw processing ───────────────────────────────────

  let lastProcessedTxIdx = 0;

  function processMockTransactions(transactions) {
    for (let i = lastProcessedTxIdx; i < transactions.length; i++) {
      const tx = transactions[i];
      try {
        if (!tx.memo) continue;
        const memo = JSON.parse(tx.memo);
        const timestampMs = tx.created_at ? Date.parse(tx.created_at) : Date.now();
        const ageMs = Date.now() - timestampMs;
        const assignedTick = timestampToTick(timestampMs);
        console.log(`[sands-tx] mock tx picked up: created_at age=${(ageMs / 1000).toFixed(1)}s  assignedTick=${assignedTick}  serverTick=${tickCount}`);
        addTransaction({
          timestamp_ms: timestampMs,
          memo,
          from: tx.from_pubkey || "mock",
        });
      } catch (_) {}
    }
    lastProcessedTxIdx = transactions.length;
  }

  // ── Snapshot system ─────────────────────────────────────────────────────

  let lastSnapshot = null;
  let transactionsSinceSnapshot = [];
  let lastSnapshotTime = Date.now();

  function captureSnapshot() {
    const cellsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE));
    const windsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE));
    const burnsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE));

    const allBufs = Buffer.concat([cellsCopy, windsCopy, burnsCopy]);
    const compressed = zlib.deflateSync(allBufs, { level: 1 });
    lastSnapshot = {
      tick: tickCount,
      timestamp: Date.now(),
      cells_b64: compressed.toString("base64"),
      prng_state: prng ? prng.getState() : 0,
      generation: universe.generation ? universe.generation() : 0,
      wasm_rng_state: universe.rng_state ? String(universe.rng_state()) : "0",
      buffers: 3,
      width: WIDTH,
      height: HEIGHT,
      chain_id: chainId || undefined,
      epoch: TICK_EPOCH,
    };
    transactionsSinceSnapshot = [];
    lastSnapshotTime = Date.now();
    console.log(`[snapshot] created at tick ${tickCount} (${(compressed.length / 1024).toFixed(1)} KB compressed)`);
    return lastSnapshot;
  }

  let _warnedNoPersist = false;
  function saveSnapshotToDisk() {
    if (!lastSnapshot) return;
    if (!canPersistSnapshots) {
      if (!_warnedNoPersist) {
        console.warn("[snapshot] not saving to disk: missing chainId or epoch — running ephemerally to avoid fallback-epoch poisoning. Future boots will replay from genesis until chain info becomes available.");
        _warnedNoPersist = true;
      }
      return;
    }
    try {
      const filePath = path.join(snapshotDir, "snapshot.json");
      fs.writeFileSync(filePath, JSON.stringify(lastSnapshot));
      console.log(`[snapshot] saved to ${filePath}`);
    } catch (e) {
      console.warn(`[snapshot] failed to save: ${e.message}`);
    }
  }

  function loadSnapshotFromDisk() {
    try {
      const filePath = path.join(snapshotDir, "snapshot.json");
      if (!fs.existsSync(filePath)) return false;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!data.cells_b64 || !data.tick) return false;

      const compressed = Buffer.from(data.cells_b64, "base64");
      const raw = zlib.inflateSync(compressed);

      if (data.buffers === 3 && raw.length === FRAME_SIZE * 3) {
        new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset, FRAME_SIZE));
        new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset + FRAME_SIZE, FRAME_SIZE));
        new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset + FRAME_SIZE * 2, FRAME_SIZE));
      } else {
        new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
      }

      tickCount = data.tick;
      if (prng && data.prng_state !== undefined) prng.setState(data.prng_state);
      if (universe.set_generation && data.generation !== undefined) universe.set_generation(data.generation);
      if (universe.set_rng_state && data.wasm_rng_state !== undefined) {
        universe.set_rng_state(BigInt(data.wasm_rng_state));
      }
      lastSnapshot = data;
      console.log(`[snapshot] loaded from disk at tick ${tickCount}`);
      return true;
    } catch (e) {
      console.warn(`[snapshot] failed to load from disk: ${e.message}`);
      return false;
    }
  }

  // ── Windowed deterministic replay ────────────────────────────────────────
  //
  // Physics only simulates during "active windows": 10 minutes after genesis
  // and 10 minutes after each draw transaction. Between windows the canonical
  // state freezes and tickCount jumps forward without physics.

  const replayTxs = (opts && opts.replayTxs) || [];
  let activeUntilTick = 0;

  let snapshotLoaded = loadSnapshotFromDisk();

  if (snapshotLoaded && lastSnapshot) {
    let discard = false;
    const reason = [];

    const snapChain = lastSnapshot.chain_id || null;
    const snapEpoch = lastSnapshot.epoch || DEFAULT_TICK_EPOCH;

    // Pre-fix snapshots (no chain_id) cannot be reasoned about: they
    // were either written by a successful boot for THIS chain, or by
    // some earlier boot that fell back to DEFAULT_TICK_EPOCH because
    // chain discovery failed. Without chain_id we can't tell which,
    // and the latter case has a wrong epoch that would corrupt
    // engine timing. Reject explicitly so the user sees why.
    if (chainId && !snapChain) {
      reason.push("snapshot lacks chain_id (pre-fix format — cannot verify chain or epoch)");
      discard = true;
    }
    if (chainId && snapChain && snapChain !== chainId) {
      reason.push(`chain_id mismatch (snapshot: ${snapChain.slice(0, 16)}…, current: ${chainId.slice(0, 16)}…)`);
      discard = true;
    }
    if (snapEpoch !== TICK_EPOCH) {
      reason.push(`epoch mismatch (snapshot: ${new Date(snapEpoch).toISOString()}, current: ${new Date(TICK_EPOCH).toISOString()})`);
      discard = true;
    }

    if (discard) {
      console.log(`[snapshot] discarding disk snapshot: ${reason.join("; ")}`);
      snapshotLoaded = false;
    }
  }

  if (!snapshotLoaded) {
    tickCount = 0;
  }

  // Parse replay txs: extract timestamp + drawing memo, filter to sands
  // events (draws + admin resets). Resets from non-admin senders are
  // filtered here so the replay loop doesn't need a second validation
  // pass. `kind` is either "draw" or "reset".
  const replayEvents = [];
  for (const tx of replayTxs) {
    try {
      if (!tx.memo) continue;
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      if (memo.app !== "falling-sands") continue;
      const from = tx.source || tx.from_pubkey || "chain";
      let kind = null;
      if (memo.type === "draw") kind = "draw";
      else if (memo.type === "reset" && isAdminResetMemo(memo, from)) kind = "reset";
      if (!kind) continue;
      const ts = tx.timestamp_ms || (tx.created_at ? Date.parse(tx.created_at) : 0);
      if (!ts) continue;
      const txTick = computeDrawTick({ timestamp_ms: ts, inclusion_latency_ms: tx.inclusion_latency_ms });
      if (txTick <= tickCount) continue;
      replayEvents.push({ tick: txTick, memo, from, kind });
    } catch (_) {}
  }
  replayEvents.sort((a, b) => a.tick - b.tick);

  // Genesis window: simulate 10 min from wherever we start
  activeUntilTick = tickCount + WINDOW_TICKS;

  // ── Async replay (non-blocking) ─────────────────────────────────────────
  //
  // The replay yields to the event loop periodically so the server can
  // accept WebSocket connections and serve static files during startup.
  // Clients that connect before replay is done receive "loading" messages
  // with progress updates.

  let engineReady = false;
  let replayProgress = 0;
  const waitingClients = [];

  function sendLoadingProgress() {
    const msg = JSON.stringify({ type: "loading", progress: replayProgress });
    for (let i = waitingClients.length - 1; i >= 0; i--) {
      const ws = waitingClients[i];
      if (ws.readyState === WebSocket.OPEN) {
        safeSend(ws, msg);
      } else {
        waitingClients.splice(i, 1);
      }
    }
  }

  async function init() {
    const nowTick = timestampToTick(Date.now());
    const replayT0 = Date.now();
    let lastProgressLog = replayT0;
    let drawsApplied = 0;
    let resetsApplied = 0;
    let physicsTicksSimulated = 0;
    let ticksSkipped = 0;

    const replayStartTick = tickCount;
    const replayTargetTick = nowTick;
    const totalSpan = Math.max(1, replayTargetTick - replayStartTick);

    {
      const fromLabel = snapshotLoaded ? `snapshot tick ${tickCount}` : "genesis (tick 0)";
      const nDraws = replayEvents.filter(e => e.kind === "draw").length;
      const nResets = replayEvents.filter(e => e.kind === "reset").length;
      console.log(`[replay] starting from ${fromLabel}, timeline span ${totalSpan} ticks (${(totalSpan / TICK_HZ).toFixed(1)}s), ${nDraws} draw txs, ${nResets} admin reset txs, window=${WINDOW_SECONDS}s`);
    }

    // Tuned so the entire combined examples server (HTTP, /__usernames/state,
    // /__game/state, /opinion-market/api, etc.) stays responsive while
    // falling-sands replays its history. Each `universe.tick_n(N)` call is a
    // single synchronous WASM block, so N directly bounds worst-case request
    // latency: at the observed ~1280 ticks/s, N=128 ≈ 100ms per block. We
    // yield after every batch so HTTP handlers run between WASM blocks.
    // (Previous values N=512 / yield-every-2048 stalled the event loop for
    // up to ~1.6s at a time, making the rest of the server feel broken.)
    const REPLAY_BATCH = 128;

    async function advancePhysicsTo(target) {
      while (tickCount < target) {
        const chunk = Math.min(REPLAY_BATCH, target - tickCount);
        universe.tick_n(chunk);
        tickCount += chunk;
        physicsTicksSimulated += chunk;

        replayProgress = Math.min(0.99, (tickCount - replayStartTick) / totalSpan);
        sendLoadingProgress();
        await new Promise(resolve => setImmediate(resolve));

        const now = Date.now();
        if (now - lastProgressLog >= 2000) {
          const elapsed = ((now - replayT0) / 1000).toFixed(1);
          const rate = physicsTicksSimulated > 0 ? (physicsTicksSimulated / ((now - replayT0) / 1000)).toFixed(0) : "?";
          console.log(`[replay] tick ${tickCount} — ${elapsed}s elapsed — ${rate} ticks/s — ${physicsTicksSimulated} simulated, ${ticksSkipped} skipped — ${drawsApplied}/${replayEvents.length} draws, ${resetsApplied} resets`);
          lastProgressLog = now;
        }
      }
    }

    for (const ev of replayEvents) {
      const evTick = Math.min(ev.tick, nowTick);

      if (evTick > activeUntilTick) {
        const windowEnd = Math.min(activeUntilTick, nowTick);
        if (tickCount < windowEnd) await advancePhysicsTo(windowEnd);
        const gap = evTick - tickCount;
        if (gap > 0) {
          ticksSkipped += gap;
          tickCount = evTick;
        }
      } else {
        if (tickCount < evTick) await advancePhysicsTo(evTick);
      }

      if (ev.kind === "reset") {
        // Wipe everything applied before this point in history — the reset
        // is the authoritative boundary. Physics window restarts from the
        // reset tick so the subsequent draws aren't stranded in a frozen
        // state during the replay.
        reseedUniverse();
        activeUntilTick = tickCount + WINDOW_TICKS;
        resetsApplied++;
        console.log(`[replay] applied admin reset at tick ${tickCount} by ${(ev.from || "").slice(0, 16)}…`);
      } else {
        activeUntilTick = Math.max(activeUntilTick, evTick + WINDOW_TICKS);
        applyDrawMemo(ev.memo, `${(ev.from || "").slice(0, 16)}… (replay)`);
        drawsApplied++;
      }

      // Update progress after skips (which are instant)
      replayProgress = Math.min(0.99, (tickCount - replayStartTick) / totalSpan);
    }

    // Finish the final active window (capped at now)
    const finalWindowEnd = Math.min(activeUntilTick, nowTick);
    if (tickCount < finalWindowEnd) await advancePhysicsTo(finalWindowEnd);

    if (tickCount < nowTick) {
      ticksSkipped += nowTick - tickCount;
      tickCount = nowTick;
    }

    {
      const elapsed = ((Date.now() - replayT0) / 1000).toFixed(1);
      console.log(`[replay] complete in ${elapsed}s — ${physicsTicksSimulated} ticks simulated (${(physicsTicksSimulated / TICK_HZ).toFixed(1)}s of physics), ${ticksSkipped} skipped — ${drawsApplied} draws applied, ${resetsApplied} admin resets applied — canonical tick ${tickCount}`);
    }

    captureSnapshot();
    if (physicsTicksSimulated > TICK_HZ * 60) {
      saveSnapshotToDisk();
    }

    // Engine is now ready — send init to all clients that connected during replay
    engineReady = true;
    replayProgress = 1;
    for (const ws of waitingClients) {
      if (ws.readyState === WebSocket.OPEN) {
        readyClients.add(ws);
        sendInitMessage(ws);
      }
    }
    if (waitingClients.length > 0) {
      console.log(`[replay] sent init to ${waitingClients.length} waiting client(s)`);
    }
    waitingClients.length = 0;
  }

  // ── Transaction management ──────────────────────────────────────────────

  // Advances the canonical tick counter to `targetTick`, running physics
  // if we're still inside the active window and jumping past any frozen
  // gap (matching the draw-path behaviour so draws and resets share
  // identical time-advancement semantics).
  function advanceToTick(targetTick) {
    if (targetTick > tickCount && targetTick > activeUntilTick) {
      tickCount = targetTick;
    } else if (targetTick > tickCount) {
      const target = Math.min(targetTick, activeUntilTick);
      while (tickCount < target) {
        universe.tick();
        tickCount++;
      }
      if (targetTick > tickCount) tickCount = targetTick;
    }
  }

  // Apply an admin reset live: advance the sim clock to the reset's
  // canonical tick, wipe the universe back to its seeded content, clear
  // the per-snapshot tx log (nothing pre-reset should reach a freshly
  // connecting client), capture + persist the new canonical state, and
  // push it to every already-connected client as a `resync`. Starts a
  // fresh physics window from the reset tick so users see motion instead
  // of reconnecting into a frozen canvas.
  function applyResetLive(tx) {
    const resetTick = computeDrawTick(tx);
    advanceToTick(resetTick);

    reseedUniverse();
    activeUntilTick = tickCount + WINDOW_TICKS;

    transactionsSinceSnapshot = [];
    captureSnapshot();
    saveSnapshotToDisk();
    broadcastResync();

    console.log(`[reset] admin reset applied at tick ${tickCount} by ${(tx.from || "").slice(0, 16)}…`);
  }

  function addTransaction(txData) {
    const tx = {
      timestamp_ms: txData.timestamp_ms || Date.now(),
      inclusion_latency_ms: txData.inclusion_latency_ms,
      memo: txData.memo,
      from: txData.from || "unknown",
    };

    const isDraw = tx.memo && tx.memo.app === "falling-sands" && tx.memo.type === "draw";
    const isReset = tx.memo && tx.memo.app === "falling-sands" && tx.memo.type === "reset";

    if (isReset) {
      if (isAdminResetMemo(tx.memo, tx.from)) {
        applyResetLive(tx);
      }
      // Even when ignored (non-admin sender or no admin configured) we
      // don't push into transactionsSinceSnapshot — replaying a rejected
      // reset on a fresh client would be pointless and just bloats the
      // init payload.
      return;
    }

    if (isDraw) {
      const drawTick = computeDrawTick(tx);
      advanceToTick(drawTick);

      applyDrawMemo(tx.memo, `${(tx.from || "").slice(0, 16)}… (live)`);

      activeUntilTick = Math.max(activeUntilTick, drawTick + WINDOW_TICKS);

      broadcastTx({
        timestamp_ms: tickToTimestamp(drawTick),
        memo: tx.memo,
        from: tx.from,
      });

      console.log(`[window] draw received — canonical tick ${tickCount}, active until tick ${activeUntilTick} (${((activeUntilTick - tickCount) / TICK_HZ).toFixed(0)}s remaining)`);
    }

    transactionsSinceSnapshot.push(tx);
  }

  // ── WebSocket — transaction relay ───────────────────────────────────────

  let wss = null;
  const readyClients = new WeakSet();

  function safeSend(ws, data) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(data); }
    catch (e) { console.error("send error:", e.message); }
  }

  function broadcastResync() {
    if (!wss) return;
    const msg = JSON.stringify({
      type: "resync",
      snapshot: lastSnapshot,
      transactions: transactionsSinceSnapshot,
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      activeUntilTick,
      adminPubkey,
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && readyClients.has(client)) {
        safeSend(client, msg);
      }
    }
  }

  function broadcastTx(txData) {
    if (!wss) return;
    const msg = JSON.stringify({
      type: "tx",
      timestamp_ms: txData.timestamp_ms,
      memo: txData.memo,
      from: txData.from,
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && readyClients.has(client)) {
        safeSend(client, msg);
      }
    }
  }

  function sendInitMessage(ws) {
    captureSnapshot();

    const frozen = tickCount >= activeUntilTick;
    const snapshotAgeSec = ((Date.now() - lastSnapshotTime) / 1000).toFixed(1);
    const txsSince = transactionsSinceSnapshot.length;
    console.log(`[init] snapshot at tick ${lastSnapshot.tick}  age=${snapshotAgeSec}s  frozen=${frozen}  txsSinceSnapshot=${txsSince}`);

    const initMsg = {
      type: "init",
      config: { width: WIDTH, height: HEIGHT, sources: sourcesEnabled },
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      snapshot: lastSnapshot,
      transactions: transactionsSinceSnapshot,
      frozen,
      activeUntilTick: frozen ? tickCount : activeUntilTick,
      // Surfaced so the client can conditionally show the admin reset
      // button without needing a separate HTTP endpoint. `null` when
      // SANDS_ADMIN_PUBKEY isn't configured — the client treats that as
      // "no admin".
      adminPubkey,
    };
    safeSend(ws, JSON.stringify(initMsg));
  }

  function attachWebSocket(httpServer) {
    wss = new WebSocket.Server({ server: httpServer, perMessageDeflate: false });

    // Keep-alive ping
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws._pongPending) { ws.terminate(); continue; }
        ws._pongPending = true;
        ws.ping();
      }
    }, PING_INTERVAL);

    wss.on("connection", (ws, req) => {
      const connTime = Date.now();
      const socket = req.socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);

      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      const ua = (req.headers["user-agent"] || "").slice(0, 80);
      console.log(`WS  connected     (total: ${wss.clients.size})  ip=${ip}  ua=${ua}`);

      ws._pongPending = false;
      ws.on("pong", () => { ws._pongPending = false; });

      ws.on("message", (msg) => {
        const txt = msg.toString();
        if (txt === "ping") { try { ws.send("pong"); } catch(_) {} return; }

        try {
          const cmd = JSON.parse(msg);
          if (cmd.type === "ready") {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!engineReady) {
              waitingClients.push(ws);
              safeSend(ws, JSON.stringify({ type: "loading", progress: replayProgress }));
              console.log(`WS  client queued (engine loading, ${waitingClients.length} waiting)`);
              return;
            }
            readyClients.add(ws);
            sendInitMessage(ws);
            const total = [...wss.clients].filter(c => readyClients.has(c)).length;
            console.log(`WS  client ready   (total ready: ${total})`);
          } else if (cmd.type === "reset") {
            universe.reset();
          }
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        const idx = waitingClients.indexOf(ws);
        if (idx !== -1) waitingClients.splice(idx, 1);
        const elapsed = Date.now() - connTime;
        const r = reason ? reason.toString() : "";
        console.log(`WS  disconnected  code=${code}${r ? " reason=" + r : ""}  after=${elapsed}ms  remaining=${wss.clients.size}`);
      });

      ws.on("error", (err) => { console.error(`WS  error: ${err.message}`); });
    });

    return wss;
  }

  // ── Simulation tick loop ───────────────────────────────────────────────

  let lastStatsTime = Date.now();
  let wasActive = tickCount < activeUntilTick;

  function tick() {
    const wallTick = timestampToTick(Date.now());
    const isActive = tickCount < activeUntilTick && tickCount < wallTick;

    if (isActive) {
      universe.tick();
      tickCount++;
      ticksProcessed++;
    }

    // Transition active → frozen: save snapshot
    if (wasActive && !isActive) {
      console.log(`[window] physics frozen at tick ${tickCount}`);
      captureSnapshot();
      saveSnapshotToDisk();
    }
    wasActive = isActive;

    // Periodic snapshot (while active)
    if (isActive && Date.now() - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
      captureSnapshot();
      saveSnapshotToDisk();
    }

    // Periodic stats
    const now = Date.now();
    if (now - lastStatsTime >= 10000) {
      const clientCount = wss ? wss.clients.size : 0;
      const txCount = transactionsSinceSnapshot.length;
      const state = isActive ? "active" : "frozen";
      console.log(`[stats] tick ${tickCount} (${state})  |  ${clientCount} client(s)  |  ${txCount} txs since snapshot`);
      lastStatsTime = now;
    }
  }

  function startTickLoop() {
    setInterval(tick, 1000 / TICK_HZ);
  }

  // ── HTTP handlers for snapshot and transactions ─────────────────────────

  function handleSnapshotRequest(req, res) {
    if (!lastSnapshot) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No snapshot available" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    });
    res.end(JSON.stringify(lastSnapshot));
  }

  function handleTransactionsRequest(req, res) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      currentTick: tickCount,
      transactions: transactionsSinceSnapshot,
    }));
  }

  // Unified routing for createAppStateCache: returns true iff handled.
  function handleRequest(req, res, pathname) {
    if (pathname === "/__sands/snapshot") { handleSnapshotRequest(req, res); return true; }
    if (pathname === "/__sands/transactions") { handleTransactionsRequest(req, res); return true; }
    return false;
  }

  // Unified processTransaction(rawTx) for createAppStateCache: applies the
  // memo to the simulation and adds it to the transactions log. Used for
  // both live-polled and mock-drained txs. Backfill happens via the
  // `replayTxs` constructor opt + windowed-replay logic in init() above —
  // the cache helper is configured with `backfill: false` so this path is
  // not called for historical txs.
  function processChainTransaction(rawTx) {
    if (!rawTx || !rawTx.memo) return;
    let memo;
    try { memo = typeof rawTx.memo === "string" ? JSON.parse(rawTx.memo) : rawTx.memo; }
    catch (_) { return; }
    const from = rawTx.source || rawTx.from_pubkey || rawTx.from || "unknown";
    const timestampMs = rawTx.timestamp_ms || (rawTx.created_at ? Date.parse(rawTx.created_at) : Date.now());
    // Hand the memo to addTransaction and let it run the canonical path:
    //   tick forward to drawTick → applyDrawMemo → broadcast.
    // Painting here too would consume mulberry32 (Cell::new draws Math.random
    // for `ra`) on the server but not on clients (clients only paint at the
    // broadcast tick), causing the shared host PRNG to drift between server
    // and client and breaking cell-init and species-paths that mix Math.random
    // (fungus / fire / plant / seed cascades).
    addTransaction({
      timestamp_ms: timestampMs,
      inclusion_latency_ms: rawTx.inclusion_latency_ms,
      memo,
      from,
    });
  }

  function reset() {
    if (universe && typeof universe.reset === "function") universe.reset();
  }

  return {
    universe,
    applyDrawMemo,
    addTransaction,
    processMockTransactions,
    processChainTransaction,
    handleRequest,
    attachWebSocket,
    startTickLoop,
    init,
    reset,
    handleSnapshotRequest,
    handleTransactionsRequest,
    captureSnapshot,
    config: { width: WIDTH, height: HEIGHT, tickHz: TICK_HZ, epoch: TICK_EPOCH },
  };
}

module.exports = createEngine;
