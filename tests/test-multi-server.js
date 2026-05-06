#!/usr/bin/env node
/**
 * test-multi-server.js
 *
 * Spawns two independent "server" processes, feeds them the same set of
 * timestamped transactions (simulating a chain poller), and verifies that
 * both produce identical cell buffer hashes at the same target tick.
 *
 * This proves that two independently running servers with the same inputs
 * produce identical state — the core guarantee of the architecture.
 *
 * Usage:
 *   node tests/test-multi-server.js
 */

const { fork } = require("child_process");
const path = require("path");

const WORKER_PATH = path.join(__dirname, "test-server-worker.js");
const TICK_HZ = 30;
const TICK_INTERVAL_MS = 1000 / TICK_HZ;
const TICK_EPOCH = 1767225600000;

function tickToTimestamp(tick) {
  return TICK_EPOCH + tick * TICK_INTERVAL_MS;
}

const TARGET_TICK = 2000;

// Timestamped transactions — these simulate what a chain poller would deliver.
// Timestamps map to specific ticks via timestampToTick().
const TRANSACTIONS = [
  { timestamp_ms: tickToTimestamp(100), memo: { app: "falling-sands", type: "draw", s: [[50, 50, 80, 80, 4, 2]] } },
  { timestamp_ms: tickToTimestamp(300), memo: { app: "falling-sands", type: "draw", s: [[150, 100, 200, 150, 6, 3]] } },
  { timestamp_ms: tickToTimestamp(600), memo: { app: "falling-sands", type: "draw", s: [[100, 200, 120, 220, 3, 8]] } },
  { timestamp_ms: tickToTimestamp(1000), memo: { app: "falling-sands", type: "draw", s: [[250, 50, 250, 200, 5, 2]] } },
  { timestamp_ms: tickToTimestamp(1500), memo: { app: "falling-sands", type: "draw", s: [[10, 300, 290, 300, 8, 1]] } },
  { timestamp_ms: tickToTimestamp(1800), memo: { app: "falling-sands", type: "draw", s: [[200, 400, 250, 430, 4, 16]] } },
];

function spawnServer() {
  return new Promise((resolve, reject) => {
    let result = null;
    let done = false;
    const worker = fork(WORKER_PATH, [], { stdio: "pipe" });

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        worker.send({
          cmd: "run",
          targetTick: TARGET_TICK,
          transactions: TRANSACTIONS,
        });
      } else if (msg.type === "hash") {
        result = { tick: msg.tick, hash: msg.hash };
      } else if (msg.type === "done") {
        done = true;
        resolve({ ...result, elapsedMs: msg.elapsedMs });
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
  console.log("Falling Sands — Multi-Server Sync Test");
  console.log("=======================================");
  console.log(`  Target tick: ${TARGET_TICK}`);
  console.log(`  Transactions: ${TRANSACTIONS.length} draw(s)`);
  console.log(`  Each at ticks: ${TRANSACTIONS.map(t => Math.floor((t.timestamp_ms - TICK_EPOCH) / TICK_INTERVAL_MS)).join(", ")}\n`);

  console.log("  Spawning two server processes...");
  const [s1, s2] = await Promise.all([spawnServer(), spawnServer()]);

  const match = s1.hash === s2.hash;
  console.log(`\n  Server 1:  tick ${s1.tick}  hash ${s1.hash.slice(0, 24)}…  (${s1.elapsedMs.toFixed(1)} ms)`);
  console.log(`  Server 2:  tick ${s2.tick}  hash ${s2.hash.slice(0, 24)}…  (${s2.elapsedMs.toFixed(1)} ms)`);
  console.log(`\n  Hashes ${match ? "MATCH" : "MISMATCH"}`);

  console.log(`\n${match ? "PASS" : "FAIL"}: Multi-server sync test ${match ? "passed" : "failed"}`);
  process.exit(match ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
