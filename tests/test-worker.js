/**
 * test-worker.js
 *
 * Runs as a child_process.fork() worker. Loads the WASM module in its own
 * process (fresh PRNG state), seeds the universe, runs N ticks with optional
 * transactions, and reports SHA-256 hashes of the cell buffer at checkpoints.
 *
 * IPC messages received from parent:
 *   { cmd: "run", checkpoints: [100, 500, ...], transactions: [{ tick, memo }] }
 *
 * IPC messages sent to parent:
 *   { type: "hash", tick: N, hash: "hex..." }
 *   { type: "done", totalTicks: N, elapsedMs: N }
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

process.on("message", (msg) => {
  if (msg.cmd !== "run") return;

  try {
    const { checkpoints, transactions } = msg;
    const txByTick = new Map();
    if (transactions) {
      for (const t of transactions) {
        if (!txByTick.has(t.tick)) txByTick.set(t.tick, []);
        txByTick.get(t.tick).push(t.memo);
      }
    }

    const wasmLoaderPath = path.join(__dirname, "..", "wasm-loader");
    const { Universe, Species, memory } = require(wasmLoaderPath);

    const universe = Universe.new(WIDTH, HEIGHT);
    seedUniverse(universe, Species, memory);

    const checkpointSet = new Set(checkpoints || []);
    const maxTick = Math.max(...(checkpoints || [0]));

    const start = performance.now();

    for (let tick = 1; tick <= maxTick; tick++) {
      // Apply any transactions scheduled for this tick before ticking
      const txs = txByTick.get(tick);
      if (txs) {
        for (const memo of txs) {
          applyDrawMemo(universe, memo);
        }
      }

      universe.tick();

      if (checkpointSet.has(tick)) {
        const cellPtr = universe.cells();
        const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
        const hash = sha256(Buffer.from(cells));
        process.send({ type: "hash", tick, hash });
      }
    }

    const elapsed = performance.now() - start;
    process.send({ type: "done", totalTicks: maxTick, elapsedMs: elapsed });
  } catch (e) {
    process.send({ type: "error", message: e.stack || e.message });
  }
});

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

process.send({ type: "ready" });
