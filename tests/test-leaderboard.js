#!/usr/bin/env node
/**
 * test-leaderboard.js
 *
 * Exercises the deterministic scoring + leaderboard logic in
 * lib/leaderboard-store.js (no chain, no Postgres — pure in-memory).
 *
 *   1) Determinism / idempotency: feeding a fixed tx list twice (and
 *      shuffled) yields identical per-player aggregates.
 *   2) Admin reset in the stream does NOT reduce cumulative scores; a
 *      chain_id change (onChainReset) clears them.
 *   3) Leaderboard ordering matches the recomputed order for both the
 *      "all" and "daily" scopes.
 *   4) Anti-cheat: erase-only draws score zero; oversized memos are
 *      clamped.
 *
 * Usage: node tests/test-leaderboard.js
 */

const assert = require("assert");
const {
  createLeaderboardStore,
  scoreDrawMemo,
  computeStreaks,
  DRAW_BONUS,
} = require("../lib/leaderboard-store");

// Fixed reference "now" so daily/streak results are reproducible.
const NOW = Date.UTC(2026, 5, 13, 12, 0, 0); // 2026-06-13T12:00:00Z
const DAY = 86400000;

let passed = 0;
function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function draw(id, from, daysAgo, segs) {
  return {
    tx_id: id,
    source: from,
    timestamp_ms: NOW - daysAgo * DAY + 3600000,
    memo: { app: "falling-sands", type: "draw", s: segs },
  };
}

const ALICE = "ut1_alice";
const BOB = "ut1_bob";

// A fixed scenario.
function scenario() {
  return [
    // Alice: two draws today + one yesterday, multiple species.
    draw("a1", ALICE, 0, [[20, 20, 200, 300, 8, 2], [40, 40, 120, 220, 6, 3]]),
    draw("a2", ALICE, 0, [[10, 10, 80, 90, 5, 6]]),
    draw("a3", ALICE, 1, [[30, 30, 150, 280, 7, 13]]),
    // Bob: one big draw 3 days ago, one species.
    draw("b1", BOB, 3, [[10, 10, 290, 440, 12, 2]]),
    // An admin reset somewhere in the stream — must not zero scores.
    {
      tx_id: "reset1",
      source: "ut1_admin",
      timestamp_ms: NOW - 2 * DAY,
      memo: { app: "falling-sands", type: "reset" },
    },
    // Bob again, after the reset.
    draw("b2", BOB, 1, [[50, 50, 90, 120, 4, 8]]),
  ];
}

function aggregateSnapshot(store) {
  // Capture a comparable, order-independent view of all players.
  const lb = store.getLeaderboard({ scope: "all", now: NOW, limit: 1000 });
  return lb.top
    .map((r) => `${r.pubkey}|${r.score}|${r.pixels}|${r.draws}|${r.species}|${r.bestStreak}`)
    .sort()
    .join("\n");
}

// ── 1) Determinism / idempotency ─────────────────────────────────────
(function testDeterminism() {
  console.log("Test 1: determinism / idempotency");

  const s1 = createLeaderboardStore({ databaseUrl: null });
  s1.ingestAll(scenario());
  const snap1 = aggregateSnapshot(s1);

  // Same list again into a fresh store → identical.
  const s2 = createLeaderboardStore({ databaseUrl: null });
  s2.ingestAll(scenario());
  const snap2 = aggregateSnapshot(s2);
  assert.strictEqual(snap1, snap2, "two fresh stores must match");
  ok("two fresh stores produce identical aggregates");

  // Re-ingesting the SAME txs (same ids) must be a no-op (dedup).
  s1.ingestAll(scenario());
  assert.strictEqual(aggregateSnapshot(s1), snap1, "re-ingest must be idempotent");
  ok("re-ingesting identical txs is idempotent (dedup by id)");

  // Shuffled order → identical aggregates.
  const shuffled = scenario().reverse();
  const s3 = createLeaderboardStore({ databaseUrl: null });
  s3.ingestAll(shuffled);
  assert.strictEqual(aggregateSnapshot(s3), snap1, "order must not matter");
  ok("ingest order does not change aggregates");
})();

// ── 2) Admin reset vs chain reset ────────────────────────────────────
(function testResets() {
  console.log("Test 2: admin reset preserved, chain reset clears");

  const store = createLeaderboardStore({ databaseUrl: null, chainId: "chainA" });
  store.ingestAll(scenario());
  const before = store.getLeaderboard({ scope: "all", now: NOW });
  assert.ok(before.totalPlayers === 2, "alice + bob ranked, admin/reset excluded");
  ok("admin reset tx in stream did not create a player or reduce scores");

  // Same chain id reset → no-op (must NOT clear).
  store.onChainReset("chainA", "chainA");
  assert.strictEqual(
    store.getLeaderboard({ scope: "all", now: NOW }).totalPlayers,
    2,
    "same-chain reset must not clear"
  );
  ok("same-chain_id reset is a no-op");

  // Different chain id → clears everything.
  store.onChainReset("chainB", "chainA");
  assert.strictEqual(
    store.getLeaderboard({ scope: "all", now: NOW }).totalPlayers,
    0,
    "chain swap must clear"
  );
  ok("different chain_id clears all scores");
})();

// ── 3) Ordering for both scopes ──────────────────────────────────────
(function testOrdering() {
  console.log("Test 3: leaderboard ordering");

  const store = createLeaderboardStore({ databaseUrl: null });
  store.ingestAll(scenario());

  const all = store.getLeaderboard({ scope: "all", now: NOW });
  // Verify ranks are dense + sorted by score desc.
  for (let i = 1; i < all.top.length; i++) {
    assert.ok(all.top[i - 1].score >= all.top[i].score, "all-time sorted desc");
    assert.strictEqual(all.top[i].rank, i + 1, "ranks are 1-based dense");
  }
  ok(`all-time ordered by score desc (leader: ${all.top[0].pubkey})`);

  const daily = store.getLeaderboard({ scope: "daily", now: NOW });
  // Only players active "today" (Alice) appear; Bob's last draw was 1 day ago.
  assert.ok(
    daily.top.every((r) => r.dailyPoints > 0),
    "daily scope drops zero-today players"
  );
  assert.ok(
    daily.top.some((r) => r.pubkey === ALICE),
    "Alice (drew today) is on the daily board"
  );
  assert.ok(
    !daily.top.some((r) => r.pubkey === BOB),
    "Bob (no draw today) is off the daily board"
  );
  for (let i = 1; i < daily.top.length; i++) {
    assert.ok(
      daily.top[i - 1].dailyPoints >= daily.top[i].dailyPoints,
      "daily sorted desc"
    );
  }
  ok("daily scope ranks only today's contributors, sorted by daily points");

  // `me` row resolves and matches the in-list row.
  const meView = store.getLeaderboard({ scope: "all", now: NOW, me: BOB });
  assert.ok(meView.you && meView.you.pubkey === BOB, "you row resolves");
  ok(`"you" row resolves with rank #${meView.you.rank}`);
})();

// ── 4) Anti-cheat: erase + clamping + streak bonus ───────────────────
(function testScoringRules() {
  console.log("Test 4: scoring rules");

  // Erase-only draw earns zero area but still counts as a draw.
  const erase = scoreDrawMemo(
    { app: "falling-sands", type: "draw", s: [[0, 0, 100, 100, 10, 0]] },
    300,
    450
  );
  assert.strictEqual(erase.area, 0, "erase area is 0");
  assert.strictEqual(erase.species.size, 0, "erase adds no species");
  ok("erase-only draw scores zero area / no discovery");

  const store = createLeaderboardStore({ databaseUrl: null });
  store.ingest(draw("e1", "ut1_eraser", 0, [[0, 0, 200, 300, 10, 0]]));
  const er = store.getLeaderboard({ scope: "all", now: NOW }).top[0];
  assert.strictEqual(er.pixels, 0, "eraser has 0 pixels");
  assert.strictEqual(er.score, DRAW_BONUS, "eraser still earns the flat draw bonus");
  ok("erase-only drawing earns exactly the flat draw bonus, no pixels");

  // Oversized size/coords are clamped — a wild memo can't out-score a
  // sane one by orders of magnitude.
  const sane = scoreDrawMemo(
    { app: "falling-sands", type: "draw", s: [[0, 0, 299, 449, 20, 2]] },
    300,
    450
  );
  const wild = scoreDrawMemo(
    { app: "falling-sands", type: "draw", s: [[-9999, -9999, 99999, 99999, 9999, 2]] },
    300,
    450
  );
  assert.ok(wild.area <= sane.area * 1.5, "oversized memo clamped near the canvas max");
  ok("oversized coordinates/size are clamped to the canvas + paint range");

  // Streak: 4 consecutive days ending today → current 4, best 4.
  const days = new Set(["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"]);
  const st = computeStreaks(days, NOW);
  assert.strictEqual(st.best, 4, "best streak 4");
  assert.strictEqual(st.current, 4, "current streak alive at 4");
  // A gap breaks the current streak.
  const broken = computeStreaks(new Set(["2026-06-01", "2026-06-02"]), NOW);
  assert.strictEqual(broken.current, 0, "stale streak is not alive");
  assert.strictEqual(broken.best, 2, "best streak still recorded");
  ok("streaks: alive tail counted, stale streak resets current but keeps best");
})();

console.log(`\nAll leaderboard tests passed (${passed} assertions). ✓`);
