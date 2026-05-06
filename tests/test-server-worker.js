/**
 * test-server-worker.js
 *
 * Simulates a server-side engine instance. Receives timestamped transactions
 * via IPC, derives tick numbers using timestampToTick(), runs the simulation
 * to a target tick, and reports a SHA-256 hash.
 *
 * IPC messages received:
 *   { cmd: "run", targetTick: N, transactions: [{ timestamp_ms, memo }] }
 *
 * IPC messages sent:
 *   { type: "hash", tick: N, hash: "hex..." }
 *   { type: "done", elapsedMs: N }
 *   { type: "error", message: "..." }
 */

const crypto = require("crypto");
const path = require("path");

const { seedUniverse, WIDTH, HEIGHT, FRAME_SIZE } = require(
  path.join(__dirname, "..", "seed-content")
);

const TICK_HZ = 30;
const TICK_INTERVAL_MS = 1000 / TICK_HZ;
const TICK_EPOCH = 1767225600000;

function timestampToTick(timestampMs) {
  return Math.floor((timestampMs - TICK_EPOCH) / TICK_INTERVAL_MS);
}

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
    const { targetTick, transactions } = msg;

    const wasmLoaderPath = path.join(__dirname, "..", "wasm-loader");
    const { Universe, Species, memory } = require(wasmLoaderPath);

    const universe = Universe.new(WIDTH, HEIGHT);
    seedUniverse(universe, Species, memory);

    // Convert timestamps to ticks and build a tick→memos map
    const txByTick = new Map();
    for (const tx of transactions || []) {
      const tick = timestampToTick(tx.timestamp_ms);
      if (tick < 1 || tick > targetTick) continue;
      if (!txByTick.has(tick)) txByTick.set(tick, []);
      txByTick.get(tick).push(tx.memo);
    }

    const start = performance.now();

    for (let tick = 1; tick <= targetTick; tick++) {
      const txs = txByTick.get(tick);
      if (txs) for (const memo of txs) applyDrawMemo(universe, memo);
      universe.tick();
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
