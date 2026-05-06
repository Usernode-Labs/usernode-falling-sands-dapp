#!/usr/bin/env node
/**
 * test-perf.js
 *
 * Benchmarks tick throughput, checkpoint save/restore, snapshot compression,
 * and fast-forward from snapshot. All work happens in-process (single PRNG
 * instance is fine for perf measurement).
 *
 * Usage:
 *   node tests/test-perf.js
 */

const crypto = require("crypto");
const zlib = require("zlib");
const path = require("path");

const { seedUniverse, WIDTH, HEIGHT, CELL_BYTES, FRAME_SIZE } = require(
  path.join(__dirname, "..", "seed-content")
);

const wasmLoaderPath = path.join(__dirname, "..", "wasm-loader");
const { Universe, Species, memory } = require(wasmLoaderPath);

function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function bench(label, fn, iterations) {
  const n = iterations || 1;
  const start = performance.now();
  let result;
  for (let i = 0; i < n; i++) result = fn();
  const elapsed = performance.now() - start;
  return { label, totalMs: elapsed, perIterMs: elapsed / n, result };
}

console.log("Falling Sands — Performance Benchmarks");
console.log("=======================================");
console.log(`  Grid: ${WIDTH}x${HEIGHT} (${(FRAME_SIZE / 1024).toFixed(0)} KB cell buffer)\n`);

// ── Setup ───────────────────────────────────────────────────────────────────
const universe = Universe.new(WIDTH, HEIGHT);
seedUniverse(universe, Species, memory);

// ── 1. Tick throughput ──────────────────────────────────────────────────────
const TICK_RUNS = [1000, 5000, 10000];
console.log("1. Tick throughput");
for (const n of TICK_RUNS) {
  const start = performance.now();
  for (let i = 0; i < n; i++) universe.tick();
  const elapsed = performance.now() - start;
  const tps = (n / (elapsed / 1000)).toFixed(0);
  console.log(`   ${String(n).padStart(6)} ticks  →  ${fmt(elapsed)}  (${tps} ticks/sec)`);
}

// ── 2. Checkpoint save (cell buffer copy) ───────────────────────────────────
console.log("\n2. Checkpoint save (buffer copy)");
const COPY_ITERS = 1000;
const copyResult = bench("buffer copy", () => {
  const cellPtr = universe.cells();
  const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
  return Buffer.from(cells);
}, COPY_ITERS);
console.log(`   ${COPY_ITERS} copies  →  ${fmt(copyResult.totalMs)} total  (${fmt(copyResult.perIterMs)}/copy)`);

// ── 3. Checkpoint restore (buffer write-back) + replay ticks ────────────────
console.log("\n3. Checkpoint restore + replay 150 ticks (~5 sec of simulation)");
const savedCheckpoint = (() => {
  const cellPtr = universe.cells();
  return Buffer.from(new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE));
})();

const RESTORE_ITERS = 50;
const restoreResult = bench("restore + 150 ticks", () => {
  const cellPtr = universe.cells();
  const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
  cells.set(savedCheckpoint);
  for (let i = 0; i < 150; i++) universe.tick();
}, RESTORE_ITERS);
console.log(`   ${RESTORE_ITERS} iterations  →  ${fmt(restoreResult.totalMs)} total  (${fmt(restoreResult.perIterMs)}/iteration)`);

// ── 4. Snapshot compression ─────────────────────────────────────────────────
console.log("\n4. Snapshot compression (zlib level 1)");
const COMPRESS_ITERS = 20;
let compressedSize = 0;
const compressResult = bench("compress", () => {
  const cellPtr = universe.cells();
  const cells = Buffer.from(new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE));
  const compressed = zlib.deflateSync(cells, { level: 1 });
  compressedSize = compressed.length;
  return compressed;
}, COMPRESS_ITERS);
console.log(`   ${COMPRESS_ITERS} compressions  →  ${fmt(compressResult.totalMs)} total  (${fmt(compressResult.perIterMs)}/compress)`);
console.log(`   Compressed size: ${(compressedSize / 1024).toFixed(1)} KB  (ratio: ${(FRAME_SIZE / compressedSize).toFixed(1)}x)`);

// ── 5. Snapshot decompression ───────────────────────────────────────────────
console.log("\n5. Snapshot decompression");
const compressedBuf = compressResult.result;
const DECOMPRESS_ITERS = 50;
const decompressResult = bench("decompress", () => {
  return zlib.inflateSync(compressedBuf);
}, DECOMPRESS_ITERS);
console.log(`   ${DECOMPRESS_ITERS} decompressions  →  ${fmt(decompressResult.totalMs)} total  (${fmt(decompressResult.perIterMs)}/decompress)`);

// ── 6. Fast-forward from snapshot (9000 ticks ≈ 5 min at 30 Hz) ───────────
console.log("\n6. Fast-forward 9000 ticks from snapshot (~5 min of simulation)");
{
  // Restore snapshot first
  const cellPtr = universe.cells();
  const cellView = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
  const decompressed = zlib.inflateSync(compressedBuf);
  cellView.set(new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.length));

  const FF_TICKS = 9000;
  const start = performance.now();
  for (let i = 0; i < FF_TICKS; i++) universe.tick();
  const elapsed = performance.now() - start;
  const tps = (FF_TICKS / (elapsed / 1000)).toFixed(0);
  console.log(`   ${FF_TICKS} ticks  →  ${fmt(elapsed)}  (${tps} ticks/sec)`);
  console.log(`   At 30 Hz, this is ${(FF_TICKS / 30).toFixed(0)} seconds of real-time simulation`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\n── Summary ──");
console.log("  Real-time requires ≥ 30 ticks/sec.");
console.log("  Fast-forward requires ≥ 1000 ticks/sec for usable catch-up.");
console.log("  Checkpoint save should be < 1 ms.");
console.log("  Snapshot compress should be < 50 ms.");
console.log("\nDone.");
