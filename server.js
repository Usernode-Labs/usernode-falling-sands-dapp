/**
 * Falling Sands — standalone server for Usernode social-vibecoding.
 *
 * Runs the sandspiel simulation server-side against the on-chain
 * transaction stream and relays state to connected browsers via
 * WebSocket. Browsers run the same WASM build locally for rendering;
 * the chain is the single source of truth.
 *
 * Modes:
 *   node server.js              — production (real chain)
 *   node server.js --local-dev  — local dev (mock transaction store)
 *
 * Auth model: falling-sands is public. There is no JWT gate on the
 * HTTP surface — any visitor can load the page and read the engine
 * state endpoints. Transaction signing happens client-side via the
 * bridge (native Usernode channel inside the Flutter WebView, or QR
 * fallback in a desktop browser). The server never reads or relies
 * on a platform identity, and it never originates transactions.
 *
 * Persistence (SV-specific): the engine writes a single snapshot.json
 * to SNAPSHOT_DIR on freeze events / every 2h active. Without
 * intervention this is ephemeral on SV (no persistent volumes), so
 * lib/snapshot-store.js mirrors snapshot.json to a single BYTEA row
 * in the per-app Postgres DB SV auto-provisions. See CLAUDE.md
 * "Persistence" for the dataflow.
 *
 * Env vars:
 *   PORT             — HTTP port (default 3000 — matches platform scaffold)
 *   APP_PUBKEY       — canvas address (required for real-chain mode)
 *   ADMIN_PUBKEY     — optional reset-permitted sender pubkey
 *   NODE_RPC_URL     — sidecar URL (default http://usernode-node:3000)
 *   USE_NODE_STREAM  — "1" to use sidecar's direct-node SSE for live tail
 *   SNAPSHOT_DIR     — on-disk snapshot directory (default /app/data)
 *   DATABASE_URL     — auto-injected by SV; used by snapshot-store.
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");

const {
  loadEnvFile,
  handleExplorerProxy,
  createMockApi,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  createDappServerStatus,
  fetchAllTransactions,
  discoverChainInfo,
} = require("./lib/dapp-server");
const { createSnapshotStore } = require("./lib/snapshot-store");
const { createLeaderboardStore } = require("./lib/leaderboard-store");
const createEngine = require("./engine");

loadEnvFile();

// ── CLI flags / config ───────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Sentinel default keeps createAppStateCache happy in --local-dev
// without forcing operators to seed APP_PUBKEY for mock-only runs.
// In production we still hard-fail below if APP_PUBKEY is missing.
const APP_PUBKEY = process.env.APP_PUBKEY || "ut1_falling_sands_default_pubkey";
const ADMIN_PUBKEY = process.env.ADMIN_PUBKEY || null;
const NODE_RPC_URL = process.env.NODE_RPC_URL || "http://usernode-node:3000";
// Direct-node SSE for sub-second live tail (vs. 5–60s explorer indexing
// lag). Defaults on; disabled when the sidecar build doesn't expose the
// recent-tx-stream endpoints. Backfill is engine-owned and stays
// explorer-driven regardless.
const USE_NODE_STREAM = (process.env.USE_NODE_STREAM ?? "1") === "1";
// Staging vs production (platform-injected). Used to gate demo seeding of
// the leaderboard so a PR preview shows a populated board.
const IS_STAGING = process.env.USERNODE_ENV === "staging";
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR
  ? path.resolve(process.env.SNAPSHOT_DIR)
  : path.join(__dirname, "data");

if (!LOCAL_DEV && !process.env.APP_PUBKEY) {
  console.error("[server] APP_PUBKEY is required in production mode (set in .env or environment)");
  process.exit(1);
}
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);

// ── Response compression ─────────────────────────────────────────────────────
// gzip/brotli for text responses (index.html ~124 KB → ~25 KB, plus the
// loader/usernames/wasm-browser JS). Registered first so every downstream
// route — static assets, the HTML shell, the versioned JS bundles — is
// compressed. The WASM binary is explicitly excluded: it's served with a
// long immutable cache and gzipping it just burns CPU for little gain on
// an already-compact module (and would interact awkwardly with the
// immutable cache). Everything else falls through to compression's default
// content-type filter.
app.use(compression({
  filter(req, res) {
    const type = res.getHeader("Content-Type");
    if (typeof type === "string" && type.includes("application/wasm")) return false;
    return compression.filter(req, res);
  },
}));

// SV's waitForHealthy probe hits /health.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Mock API (only --local-dev) ──────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });
app.use((req, res, next) => {
  if (mockApi.handleRequest(req, res, req.path)) return;
  next();
});

// ── Snapshot persistence ────────────────────────────────────────────────────
// Hydrate snapshot.json from Postgres BEFORE the engine reads it from
// disk in createEngine() below. Then start() begins watching the
// directory and mirroring engine writes back to Postgres.
const snapshotStore = createSnapshotStore({
  databaseUrl: process.env.DATABASE_URL || null,
  snapshotDir: SNAPSHOT_DIR,
});

// ── Sidecar /status probe (powers /status page node card + loader) ──────────
// Probe is created early so we can register the sands stream readiness
// lambda even though the cache itself is built inside the async init()
// below. The lambda is read fresh on every snapshot.
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
});

let engine = null;
let engineCache = null;
let leaderboard = null;

nodeStatusProbe.registerStream("sands", () => !!engineCache && engineCache.isStreamReady());
nodeStatusProbe.start();

// ── HTTP server (must exist before WebSocket attach) ────────────────────────
// We need the underlying http.Server (not just the Express app) because
// engine.attachWebSocket(server) hands it to ws's WebSocket.Server. Mount
// Express as the request handler.
const server = http.createServer(app);

// Drops every fetched tx older than the most recent admin-authored
// `{app:"falling-sands", type:"reset"}` memo. The replay loop in
// engine.js calls reseedUniverse() on every reset, which wipes the
// canvas back to seed content — so any pre-reset draws applied during
// replay are immediately discarded. Trimming them here saves the
// (potentially large) physics-window simulation cost on cold boots.
//
// Returns the input array unchanged when ADMIN_PUBKEY is unset (resets
// can't be authenticated) or when no admin reset is found in history.
//
// Invariant: this is purely a replay-cost optimization. Engine.js still
// applies its own `txTick <= tickCount` filter, so a snapshot newer than
// the latest reset transparently drops the reset (reseed would be a
// no-op anyway). And `reseedUniverse()` deliberately leaves the WASM
// PRNG alone, so trimmed vs. untrimmed cold boots reach different
// post-reset PRNG states — but each deploy is its own simulation
// (canonical dapps.usernodelabs.org and this SV deploy already diverge
// the moment they boot at different wall-clock times), so a single
// consistent trim policy per deploy preserves internal determinism.
function trimToLatestAdminReset(txs, adminPubkey) {
  if (!adminPubkey || !Array.isArray(txs) || txs.length === 0) return txs || [];

  function timestampOf(tx) {
    return tx.timestamp_ms || (tx.created_at ? Date.parse(tx.created_at) : 0);
  }

  let latestResetTs = 0;
  for (const tx of txs) {
    if (!tx || !tx.memo) continue;
    const sender = tx.source || tx.from_pubkey;
    if (sender !== adminPubkey) continue;
    let memo;
    try { memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo; }
    catch (_) { continue; }
    if (!memo || memo.app !== "falling-sands" || memo.type !== "reset") continue;
    const ts = timestampOf(tx);
    if (ts > latestResetTs) latestResetTs = ts;
  }

  if (!latestResetTs) {
    console.log(`[replay] no admin reset found in ${txs.length} backfilled tx(s) — replaying full history`);
    return txs;
  }

  const trimmed = txs.filter(tx => timestampOf(tx) >= latestResetTs);
  const skipped = txs.length - trimmed.length;
  console.log(`[replay] trimming to latest admin reset at ${new Date(latestResetTs).toISOString()}: skipping ${skipped} pre-reset tx(s), keeping ${trimmed.length}`);
  return trimmed;
}

// ── Async init: chain backfill → engine → cache → snapshot watcher ─────────
//
// Falling-sands is the one dapp that does its own backfill outside the
// shared cache helper: the engine consumes `replayTxs` in its constructor
// for windowed deterministic replay against a disk snapshot. After that
// the generic createAppStateCache takes over for live polling + mock drain.
// We pass `initialLastHeight` and `initialSeenIds` so the live poller
// picks up exactly where the engine's replay ended.
(async function init() {
  await snapshotStore.hydrate();

  const chainInfo = LOCAL_DEV
    ? { chainId: null, genesisTimestampMs: null }
    : await discoverChainInfo().catch(() => ({ chainId: null, genesisTimestampMs: null }));

  let replayTxs = [];
  let fetchedTransactions = [];
  let lastHeight = null;
  let replayIds = [];
  if (!LOCAL_DEV && chainInfo.chainId && process.env.APP_PUBKEY) {
    const fetched = await fetchAllTransactions({
      chainId: chainInfo.chainId,
      appPubkey: APP_PUBKEY,
      queryField: "recipient",
    });
    fetchedTransactions = fetched.transactions || [];
    replayTxs = trimToLatestAdminReset(fetchedTransactions, ADMIN_PUBKEY);
    // lastHeight + replayIds intentionally come from the FULL fetched set,
    // not the trimmed one — the live poller resumes from the real chain
    // tip and dedups by id, so it must see every backfilled tx id.
    lastHeight = fetched.lastHeight;
    replayIds = fetched.txIds || [];
  }

  engine = createEngine({
    wasmLoaderPath: require.resolve("./wasm-loader"),
    chainId: chainInfo.chainId,
    epoch: chainInfo.genesisTimestampMs,
    replayTxs,
    adminPubkey: ADMIN_PUBKEY,
    snapshotDir: SNAPSHOT_DIR,
  });
  engine.attachWebSocket(server);
  await engine.init();
  engine.startTickLoop();

  // Begin mirroring snapshot.json → Postgres now that the engine has
  // (re)built it. Engine writes are infrequent (freeze events / 2h
  // active windows) so a 5s debounce is comfortable.
  snapshotStore.start();

  // ── Leaderboard / scoring ────────────────────────────────────────
  // Deterministic, chain-derived scoring that lives entirely outside the
  // vendored engine. Backfill uses the FULL fetched history (NOT the
  // admin-reset-trimmed replayTxs): a canvas reset wipes pixels but must
  // not erase players' lifetime contribution. Then every live tx is
  // scored by wrapping the cache's processTransaction.
  leaderboard = createLeaderboardStore({
    databaseUrl: process.env.DATABASE_URL || null,
    chainId: chainInfo.chainId,
    width: engine.config.width,
    height: engine.config.height,
  });
  await leaderboard.init();
  leaderboard.ingestAll(fetchedTransactions); // FULL untrimmed history
  if (IS_STAGING || LOCAL_DEV) leaderboard.seedDemo();
  leaderboard.start();

  const scoredProcessTransaction = (rawTx) => {
    try {
      leaderboard.ingest(rawTx);
    } catch (e) {
      console.warn(`[leaderboard] ingest failed: ${e.message}`);
    }
    return engine.processChainTransaction(rawTx);
  };

  engineCache = createAppStateCache({
    name: "sands",
    appPubkey: APP_PUBKEY,
    queryFields: ["recipient"],
    intervalMs: 1500,
    backfill: false,                  // engine handles its own (windowed replay)
    initialLastHeight: lastHeight,    // seed live poller from where replay ended
    initialSeenIds: replayIds,
    processTransaction: scoredProcessTransaction,
    handleRequest: engine.handleRequest,
    onChainReset(newId, oldId) {
      console.log(`[sands] chain reset ${oldId} -> ${newId}, resetting engine`);
      engine.reset();
      if (leaderboard) leaderboard.onChainReset(newId, oldId);
    },
    localDev: LOCAL_DEV,
    mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
    nodeRpcUrl: USE_NODE_STREAM ? NODE_RPC_URL : null,
  });
  engineCache.start();

  // Register with the status page now that the cache exists. We do this
  // here (rather than from a setInterval poller below) because cold-boot
  // replay can take many minutes on a long chain history, well beyond
  // any reasonable polling cap. Registering inline removes the race.
  dappServerStatus.registerCache(engineCache);
})().catch((e) => {
  console.error("[server] init failed:", e);
  process.exit(1);
});

// ── Engine state APIs (gated until engine is up) ────────────────────────────
app.use((req, res, next) => {
  if (engineCache && engineCache.handleRequest(req, res, req.path)) return;
  if (!engine && (req.path === "/__sands/snapshot" || req.path === "/__sands/transactions")) {
    return res.status(503).type("text/plain").send("Engine loading...");
  }
  next();
});

// ── Leaderboard (public, read-only — same surface as the other __sands APIs) ─
// GET /__sands/leaderboard?scope=all|daily&me=<pubkey>
//   { scope, updatedAt, totalPlayers, top: [...], you: {...}|null }
// `me` lets the (public, JWT-less) client identify its own row — the page
// passes its wallet address so it can highlight/pin "You".
app.get("/__sands/leaderboard", (req, res) => {
  if (!leaderboard) {
    return res.status(503).json({ error: "Leaderboard loading..." });
  }
  const scope = req.query.scope === "daily" ? "daily" : "all";
  const me = typeof req.query.me === "string" ? req.query.me : null;
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
  const payload = leaderboard.getLeaderboard({ scope, me, limit });
  res.set("Cache-Control", "no-store");
  res.json(payload);
});

// ── Global usernames cache ───────────────────────────────────────────────────
// Same shared wiring as engineCache, just for the global usernames address.
// Connected falling-sands clients (and any other dapp the usernames module
// is loaded into) hit `GET /__usernames/state` instead of independently
// paginating the explorer.
const usernamesCache = createUsernamesCache({
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: USE_NODE_STREAM ? NODE_RPC_URL : null,
});
usernamesCache.start();
nodeStatusProbe.registerStream("usernames", () => usernamesCache.isStreamReady());

app.use((req, res, next) => {
  if (usernamesCache.handleRequest(req, res, req.path)) return;
  next();
});

app.use((req, res, next) => {
  if (nodeStatusProbe.handleRequest(req, res, req.path)) return;
  next();
});

// ── Explorer proxy ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (handleExplorerProxy(req, res, req.path)) return;
  next();
});

// ── Versioned, immutable long-cache assets ───────────────────────────────────
// The WASM module and the self-hosted regl/pako bundles are served at
// content-versioned URLs whose version segment is templated into index.html
// (see renderIndexHtml below). Because the URL changes whenever the asset
// changes, we serve with a 1-year immutable cache instead of forcing a
// revalidation round-trip on every load:
//
//   - WASM:  /sandtable_bg.<wasmVersion>.wasm — wasmVersion is a content
//            hash of the binary, so a rebuilt module ships a new URL. This
//            preserves the original anti-drift guarantee (a stale cached
//            module can never silently diverge the client physics from the
//            server's after a deploy) while letting unchanged builds load
//            from cache with zero network round-trip.
//   - regl / pako:  /<name>.<buildVersion>.min.js — buildVersion already
//            hashes every file in public/, so editing a bundle busts the URL.
//
// The route regexes accept any version segment and always serve the current
// on-disk file, so a request for a now-stale URL (e.g. from a client loaded
// just before a deploy) transparently returns the live asset.
const WASM_PATH = path.join(__dirname, "sandspiel", "crate", "pkg", "sandtable_bg.wasm");
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function sendImmutableFile(res, filePath, contentType) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return res.status(500).type("text/plain").send("Failed to read asset: " + e.message);
  }
  res.set({ "Content-Type": contentType, "Cache-Control": IMMUTABLE_CACHE });
  res.end(buf);
}

app.get(/^\/sandtable_bg\.[0-9a-z.-]+\.wasm$/, (_req, res) => {
  sendImmutableFile(res, WASM_PATH, "application/wasm");
});
app.get(/^\/regl\.[0-9a-z.-]+\.min\.js$/, (_req, res) => {
  sendImmutableFile(res, path.join(__dirname, "public", "regl.min.js"), "application/javascript; charset=utf-8");
});
app.get(/^\/pako\.[0-9a-z.-]+\.min\.js$/, (_req, res) => {
  sendImmutableFile(res, path.join(__dirname, "public", "pako.min.js"), "application/javascript; charset=utf-8");
});

// ── Build version ────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");

function computeBuildVersion() {
  const hash = crypto.createHash("sha1");
  let names;
  try { names = fs.readdirSync(PUBLIC_DIR).sort(); } catch (_) { return "unknown"; }
  for (const file of names) {
    if (file.startsWith(".")) continue;
    try {
      const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
      hash.update(file).update(data);
    } catch (_) {}
  }
  return hash.digest("hex").slice(0, 8);
}

const STARTUP_BUILD_VERSION = computeBuildVersion();
function getBuildVersion() {
  return LOCAL_DEV ? computeBuildVersion() : STARTUP_BUILD_VERSION;
}
console.log(`  Build version: ${STARTUP_BUILD_VERSION}`);

// Content hash of the WASM binary, used to version its immutable URL. Kept
// separate from the public/ build version because the WASM lives outside
// public/ — a simulation rebuild changes this hash (busting the cache and
// preserving the anti-drift guarantee) without necessarily touching any
// public/ file.
function computeWasmVersion() {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(WASM_PATH)).digest("hex").slice(0, 12);
  } catch (_) {
    return "0";
  }
}
const STARTUP_WASM_VERSION = computeWasmVersion();
function getWasmVersion() {
  return LOCAL_DEV ? computeWasmVersion() : STARTUP_WASM_VERSION;
}

app.get("/__build", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version: getBuildVersion(), localDev: LOCAL_DEV });
});

// ── Aggregated dapp-server status ───────────────────────────────────────────
const dappServerStatus = createDappServerStatus({
  name: "sands",
  nodeProbe: nodeStatusProbe,
  localDev: LOCAL_DEV,
  port: PORT,
  getBuildVersion,
});
dappServerStatus.registerCache(usernamesCache);
// engineCache is registered from inside the async init() block above
// (immediately after engineCache.start()). It can't be registered here
// at module load because the engine's cold-boot replay must finish
// first, and that takes longer than any sane polling cap on long chain
// histories.

app.use((req, res, next) => {
  if (dappServerStatus.handleRequest(req, res, req.path)) return;
  next();
});

// ── Static assets ────────────────────────────────────────────────────────────
// usernode-bridge.js, usernode-usernames.js, usernode-loading.js,
// wasm-browser.js, plus any future CSS/images. We serve wasm-browser.js
// from public/ via express.static rather than from the repo root the way
// upstream does, because in the standalone repo there's only one copy
// and it lives where index.html expects to load it from.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("X-App-Version", getBuildVersion());
  },
}));

// wasm-browser.js lives at the repo root in the upstream layout but
// index.html requests it as /wasm-browser.js. Serve from the project
// root explicitly so we don't have to move it into public/.
app.get("/wasm-browser.js", (_req, res) => {
  try {
    const buf = fs.readFileSync(path.join(__dirname, "wasm-browser.js"));
    res.set({
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch (e) {
    res.status(500).type("text/plain").send("Failed to read wasm-browser.js: " + e.message);
  }
});

// ── HTML shell ───────────────────────────────────────────────────────────────
let _indexHtmlCache = null;
let _indexHtmlVersion = null;
function renderIndexHtml() {
  const version = getBuildVersion();
  if (LOCAL_DEV || _indexHtmlCache == null || _indexHtmlVersion !== version) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    } catch (e) {
      return `<!doctype html><pre>Failed to read index.html: ${e.message}</pre>`;
    }
    _indexHtmlCache = raw
      .split("__BUILD_VERSION__").join(version)
      .split("__WASM_VERSION__").join(getWasmVersion());
    _indexHtmlVersion = version;
  }
  return _indexHtmlCache;
}

app.get("*", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-App-Version", getBuildVersion());
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderIndexHtml());
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
// Drain the snapshot-store debounce timer + finish any in-flight write
// before exit so we don't lose the last engine save when SV recreates
// the container (deploy, redeploy, etc.).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, flushing snapshot…`);
  try {
    await snapshotStore.flushNow();
  } catch (e) {
    console.warn(`[server] snapshot flush failed: ${e.message}`);
  }
  try {
    if (leaderboard) await leaderboard.flushNow();
  } catch (e) {
    console.warn(`[server] leaderboard flush failed: ${e.message}`);
  }
  try {
    server.close(() => process.exit(0));
  } catch (_) {
    process.exit(0);
  }
  // Hard ceiling — Docker's default kill grace is 10s.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nFalling Sands server running at http://localhost:${PORT}`);

  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`   LAN: http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log(`  App pubkey:    ${process.env.APP_PUBKEY ? APP_PUBKEY.slice(0, 24) + "…" : "(default sentinel — local-dev only)"}`);
  console.log(`  Admin pubkey:  ${ADMIN_PUBKEY ? ADMIN_PUBKEY.slice(0, 24) + "…" : "(unset)"}`);
  console.log(`  Node RPC:      ${NODE_RPC_URL}${USE_NODE_STREAM ? " (direct-node SSE on)" : ""}`);
  console.log(`  Snapshot dir:  ${SNAPSHOT_DIR}`);
  console.log(`  Persistence:   ${process.env.DATABASE_URL ? "Postgres" : "disk-only (DATABASE_URL unset)"}`);
  console.log(`  Mode:          ${LOCAL_DEV ? "LOCAL DEV (mock API)" : "production"}\n`);
});
