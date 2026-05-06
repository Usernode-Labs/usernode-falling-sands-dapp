#!/usr/bin/env node
/**
 * test-determinism.js
 *
 * Spawns two separate worker processes (each with an independent PRNG) and
 * compares SHA-256 hashes of the cell buffer at multiple tick checkpoints.
 * Runs two rounds:
 *   1) No transactions (pure simulation determinism)
 *   2) With hardcoded test transactions at specific ticks
 *
 * Usage:
 *   node tests/test-determinism.js
 */

const { fork } = require("child_process");
const path = require("path");

const WORKER_PATH = path.join(__dirname, "test-worker.js");
const CHECKPOINTS = [100, 500, 1000, 5000];

const TEST_TRANSACTIONS = [
  { tick: 200, memo: { app: "falling-sands", type: "draw", s: [[50, 50, 80, 80, 4, 2]] } },
  { tick: 400, memo: { app: "falling-sands", type: "draw", s: [[150, 100, 200, 150, 6, 3]] } },
  { tick: 800, memo: { app: "falling-sands", type: "draw", s: [[100, 200, 120, 220, 3, 8]] } },
  { tick: 1500, memo: { app: "falling-sands", type: "draw", s: [[250, 50, 250, 200, 5, 2]] } },
  { tick: 3000, memo: { app: "falling-sands", type: "draw", s: [[10, 300, 290, 300, 8, 1]] } },
];

function spawnWorker(checkpoints, transactions) {
  return new Promise((resolve, reject) => {
    const hashes = new Map();
    let done = false;
    const worker = fork(WORKER_PATH, [], { stdio: "pipe" });

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        worker.send({ cmd: "run", checkpoints, transactions: transactions || [] });
      } else if (msg.type === "hash") {
        hashes.set(msg.tick, msg.hash);
      } else if (msg.type === "done") {
        done = true;
        resolve({ hashes, elapsedMs: msg.elapsedMs });
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

async function runRound(label, transactions) {
  console.log(`\n── ${label} ──`);
  console.log(`  Checkpoints: ${CHECKPOINTS.join(", ")}`);
  if (transactions && transactions.length) {
    console.log(`  Transactions: ${transactions.length} draw(s) at ticks ${transactions.map(t => t.tick).join(", ")}`);
  }

  const [a, b] = await Promise.all([
    spawnWorker(CHECKPOINTS, transactions),
    spawnWorker(CHECKPOINTS, transactions),
  ]);

  let allMatch = true;
  for (const tick of CHECKPOINTS) {
    const hashA = a.hashes.get(tick);
    const hashB = b.hashes.get(tick);
    const match = hashA === hashB;
    if (!match) allMatch = false;
    const status = match ? "MATCH" : "MISMATCH";
    console.log(`  tick ${String(tick).padStart(5)}  ${status}  ${hashA.slice(0, 16)}…`);
  }

  console.log(`  Worker A: ${a.elapsedMs.toFixed(1)} ms  |  Worker B: ${b.elapsedMs.toFixed(1)} ms`);
  return allMatch;
}

async function main() {
  console.log("Falling Sands — Determinism Test");
  console.log("================================");

  const r1 = await runRound("Round 1: No transactions", []);
  const r2 = await runRound("Round 2: With test transactions", TEST_TRANSACTIONS);

  console.log("\n── Summary ──");
  console.log(`  Round 1 (no txs):   ${r1 ? "PASS" : "FAIL"}`);
  console.log(`  Round 2 (with txs): ${r2 ? "PASS" : "FAIL"}`);

  const overall = r1 && r2;
  console.log(`\n${overall ? "PASS" : "FAIL"}: Determinism test ${overall ? "passed" : "failed"}`);
  process.exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
