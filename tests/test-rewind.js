#!/usr/bin/env node
/**
 * test-rewind.js
 *
 * Validates that rewinding to a checkpoint and replaying with a late
 * transaction produces the same cell buffer as if the transaction had been
 * applied on time.
 *
 * Two worker processes run independently:
 *   Worker A ("clean"): applies all transactions at their scheduled tick
 *   Worker B ("late"):   misses the transaction at tick 500, receives it at
 *                        tick 700, rewinds to the nearest checkpoint, replays
 *
 * Both workers' cell buffer hashes at the target tick must match.
 *
 * Usage:
 *   node tests/test-rewind.js
 */

const { fork } = require("child_process");
const path = require("path");

const WORKER_PATH = path.join(__dirname, "test-rewind-worker.js");
const TARGET_TICK = 1000;
const CHECKPOINT_INTERVAL = 150;

const NORMAL_TRANSACTIONS = [
  { tick: 100, memo: { app: "falling-sands", type: "draw", s: [[30, 30, 60, 60, 3, 2]] } },
  { tick: 300, memo: { app: "falling-sands", type: "draw", s: [[200, 200, 220, 220, 4, 3]] } },
];

const LATE_TX = {
  tick: 500,
  arriveAtTick: 700,
  memo: { app: "falling-sands", type: "draw", s: [[100, 100, 150, 150, 5, 8]] },
};

const DIAGNOSTIC_TICKS = [449, 450, 500, 501, 700, 1000];

function spawnWorker(mode) {
  return new Promise((resolve, reject) => {
    let result = null;
    let done = false;
    const diags = [];
    const worker = fork(WORKER_PATH, [], { stdio: "pipe" });

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        worker.send({
          cmd: "run",
          mode,
          targetTick: TARGET_TICK,
          transactions: NORMAL_TRANSACTIONS,
          lateTransaction: LATE_TX,
          checkpointInterval: CHECKPOINT_INTERVAL,
          diagnosticTicks: DIAGNOSTIC_TICKS,
        });
      } else if (msg.type === "diag") {
        diags.push(msg);
      } else if (msg.type === "hash") {
        result = { tick: msg.tick, hash: msg.hash };
      } else if (msg.type === "done") {
        done = true;
        resolve({ ...result, elapsedMs: msg.elapsedMs, diags });
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (!done) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

async function main() {
  console.log("Falling Sands — Rewind Correctness Test");
  console.log("========================================");
  console.log(`  Target tick: ${TARGET_TICK}`);
  console.log(`  Checkpoint interval: ${CHECKPOINT_INTERVAL} ticks`);
  console.log(`  Late transaction: tick ${LATE_TX.tick}, arrives at tick ${LATE_TX.arriveAtTick}`);
  console.log(`  Diagnostic ticks: ${DIAGNOSTIC_TICKS.join(", ")}\n`);

  console.log("  Spawning workers...");
  const [clean, late] = await Promise.all([
    spawnWorker("clean"),
    spawnWorker("late"),
  ]);

  // Print diagnostics
  console.log("\n  Diagnostics:");
  const cleanDiags = new Map(clean.diags.map(d => [`${d.tick}:${d.label}`, d]));
  const lateDiags = new Map(late.diags.map(d => [`${d.tick}:${d.label}`, d]));

  for (const d of clean.diags) {
    console.log(`    [clean] tick ${String(d.tick).padStart(4)} ${(d.label || "").padEnd(12)} hash=${d.hash.slice(0, 16)}… prng=${d.prngState}`);
  }
  console.log("");
  for (const d of late.diags) {
    console.log(`    [late]  tick ${String(d.tick).padStart(4)} ${(d.label || "").padEnd(12)} hash=${d.hash.slice(0, 16)}… prng=${d.prngState}`);
  }

  // Compare specific ticks
  console.log("\n  Key comparisons:");
  for (const tick of DIAGNOSTIC_TICKS) {
    const c = clean.diags.find(d => d.tick === tick);
    const l = late.diags.find(d => d.tick === tick && (d.label === "replay" || d.label === "late-post"));
    if (c && l) {
      const hm = c.hash === l.hash ? "MATCH" : "MISMATCH";
      const pm = c.prngState === l.prngState ? "MATCH" : "MISMATCH";
      console.log(`    tick ${tick}: hash ${hm}, prng ${pm}`);
    }
  }

  const match = clean.hash === late.hash;
  console.log(`\n  Final hashes:`);
  console.log(`    Clean: ${clean.hash.slice(0, 24)}…  (${clean.elapsedMs.toFixed(1)} ms)`);
  console.log(`    Late:  ${late.hash.slice(0, 24)}…  (${late.elapsedMs.toFixed(1)} ms)`);
  console.log(`    ${match ? "MATCH" : "MISMATCH"}`);

  console.log(`\n${match ? "PASS" : "FAIL"}: Rewind correctness test ${match ? "passed" : "failed"}`);
  process.exit(match ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
