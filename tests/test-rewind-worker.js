/**
 * test-rewind-worker.js
 *
 * Worker for rewind correctness testing. Supports two modes:
 *
 * "clean" mode:
 *   Applies all transactions at their scheduled tick, runs to the target tick.
 *   Reports intermediate hashes + PRNG state at diagnostic ticks.
 *
 * "late" mode:
 *   Runs ticks without applying the "late" transaction. At a specified tick,
 *   receives the late transaction, rewinds to the nearest checkpoint before its
 *   target tick, replays with the transaction applied, and continues to the
 *   target tick. Reports intermediate hashes + PRNG state.
 *
 * IPC messages received:
 *   { cmd: "run", mode: "clean"|"late", targetTick: N,
 *     transactions: [{ tick, memo }],
 *     lateTransaction: { tick, arriveAtTick, memo },
 *     checkpointInterval: N,
 *     diagnosticTicks: [N, ...] }
 *
 * IPC messages sent:
 *   { type: "diag", tick: N, hash: "hex...", prngState: N }
 *   { type: "hash", tick: N, hash: "hex..." }
 *   { type: "done", elapsedMs: N }
 *   { type: "error", message: "..." }
 */

const crypto = require("crypto");
const path = require("path");

const { seedUniverse, WIDTH, HEIGHT, CELL_BYTES, FRAME_SIZE } = require(
  path.join(__dirname, "..", "seed-content")
);

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

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

function applyDrawMemo(universe, memo) {
  if (memo.app !== "falling-sands" || memo.type !== "draw" || !Array.isArray(memo.s)) return;
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
}

process.on("message", (msg) => {
  if (msg.cmd !== "run") return;

  try {
    const {
      mode,
      targetTick,
      transactions,
      lateTransaction,
      checkpointInterval,
      diagnosticTicks,
    } = msg;

    const wasmLoaderPath = path.join(__dirname, "..", "wasm-loader");
    const { Universe, Species, memory, prng } = require(wasmLoaderPath);

    const universe = Universe.new(WIDTH, HEIGHT);
    seedUniverse(universe, Species, memory);

    const txByTick = new Map();
    if (transactions) {
      for (const t of transactions) {
        if (!txByTick.has(t.tick)) txByTick.set(t.tick, []);
        txByTick.get(t.tick).push(t.memo);
      }
    }

    const cpInterval = checkpointInterval || 150;
    const checkpoints = new Map();
    const diagSet = new Set(diagnosticTicks || []);

    function saveCheckpoint(tick) {
      checkpoints.set(tick, {
        cells: Buffer.from(new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE)),
        winds: Buffer.from(new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE)),
        burns: Buffer.from(new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE)),
        prngState: prng.getState(),
        generation: universe.generation(),
        rngState: universe.rng_state(),
      });
    }

    function restoreCheckpoint(tick) {
      const cp = checkpoints.get(tick);
      if (!cp) return false;
      new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE).set(cp.cells);
      new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE).set(cp.winds);
      new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE).set(cp.burns);
      prng.setState(cp.prngState);
      universe.set_generation(cp.generation);
      universe.set_rng_state(cp.rngState);
      return true;
    }

    function reportDiag(tick, label) {
      const cellPtr = universe.cells();
      const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
      const hash = sha256(Buffer.from(cells));
      process.send({
        type: "diag",
        tick,
        hash,
        prngState: prng.getState(),
        label: label || "",
      });
    }

    const start = performance.now();

    if (mode === "clean") {
      if (lateTransaction) {
        if (!txByTick.has(lateTransaction.tick)) txByTick.set(lateTransaction.tick, []);
        txByTick.get(lateTransaction.tick).push(lateTransaction.memo);
      }

      for (let tick = 1; tick <= targetTick; tick++) {
        const txs = txByTick.get(tick);
        if (txs) for (const memo of txs) applyDrawMemo(universe, memo);
        universe.tick();
        if (diagSet.has(tick)) reportDiag(tick, "clean");
      }
    } else if (mode === "late") {
      let rewound = false;

      for (let tick = 1; tick <= targetTick; tick++) {
        if (tick % cpInterval === 0) {
          saveCheckpoint(tick);
        }

        const txs = txByTick.get(tick);
        if (txs) for (const memo of txs) applyDrawMemo(universe, memo);

        universe.tick();

        if (diagSet.has(tick) && !rewound) reportDiag(tick, "late-pre");

        if (!rewound && lateTransaction && tick === lateTransaction.arriveAtTick) {
          rewound = true;

          let restoreTick = 0;
          for (const cpTick of checkpoints.keys()) {
            if (cpTick <= lateTransaction.tick && cpTick > restoreTick) {
              restoreTick = cpTick;
            }
          }

          if (restoreTick > 0) {
            restoreCheckpoint(restoreTick);
            reportDiag(restoreTick, "after-restore");

            if (!txByTick.has(lateTransaction.tick)) txByTick.set(lateTransaction.tick, []);
            txByTick.get(lateTransaction.tick).push(lateTransaction.memo);

            for (let replayTick = restoreTick; replayTick <= tick; replayTick++) {
              if (replayTick % cpInterval === 0 && replayTick !== restoreTick) {
                saveCheckpoint(replayTick);
              }
              const rTxs = txByTick.get(replayTick);
              if (rTxs) for (const memo of rTxs) applyDrawMemo(universe, memo);
              universe.tick();
              if (diagSet.has(replayTick)) reportDiag(replayTick, "replay");
            }
          }
        }

        if (diagSet.has(tick) && rewound) reportDiag(tick, "late-post");
      }
    }

    const elapsed = performance.now() - start;
    const cellPtr = universe.cells();
    const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
    const hash = sha256(Buffer.from(cells));

    process.send({ type: "hash", tick: targetTick, hash });
    process.send({ type: "done", elapsedMs: elapsed });
  } catch (e) {
    process.send({ type: "error", message: e.stack || e.message });
  }
});

process.send({ type: "ready" });
