/**
 * lib/leaderboard-store.js — competitive scoring + global leaderboard.
 *
 * Falling-sands has one communal canvas; every drawing is an on-chain
 * transaction that already carries its author (`source`/`from_pubkey`).
 * This module turns that stream into per-player scores and a ranked
 * leaderboard, WITHOUT touching the vendored engine.
 *
 * Design properties:
 *
 *  - **Deterministic.** A player's score is a pure function of the draw
 *    memos they authored: painted area (excluding erase) + a flat bonus
 *    per drawing + a one-time bonus per newly-used element + a streak
 *    bonus. No randomness, no wall-clock dependence for the all-time
 *    score (only the live "Today" bucket and the *alive* streak flag are
 *    relative to now). This makes scores reconstructable by anyone
 *    replaying the chain — the same single-source-of-truth property the
 *    simulation relies on — and keeps the data model token-reward
 *    friendly (a future phase can pay out against any stored component).
 *
 *  - **Memory is the source of truth, rebuilt from chain on every boot.**
 *    `server.js` calls `ingestAll(fetchAllTransactions(...).transactions)`
 *    at boot (the FULL, untrimmed history — an admin canvas reset wipes
 *    pixels but must not erase lifetime contribution) and then
 *    `ingest(tx)` for each live tx. Two parallel deploys observing the
 *    same chain converge, matching the existing "Parallel deploys"
 *    guarantee in CLAUDE.md.
 *
 *  - **Postgres is a durable mirror** (same pattern as
 *    lib/snapshot-store.js: own small pool, CREATE TABLE IF NOT EXISTS,
 *    debounced upsert, flush on SIGTERM). If DATABASE_URL is unset the
 *    store runs memory-only and logs a one-shot warning — boot rebuilds
 *    from chain regardless, so this degrades gracefully.
 *
 * Schema (idempotent, created on init):
 *
 *   CREATE TABLE IF NOT EXISTS sands_scores (
 *     pubkey        TEXT PRIMARY KEY,
 *     score         BIGINT NOT NULL,
 *     pixels        BIGINT NOT NULL,
 *     draws         INTEGER NOT NULL,
 *     species_mask  BIGINT NOT NULL,
 *     daily_points  BIGINT NOT NULL,
 *     day_key       TEXT,
 *     streak_days   INTEGER NOT NULL,
 *     best_streak   INTEGER NOT NULL,
 *     first_ts      BIGINT,
 *     last_ts       BIGINT,
 *     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * sands_scores is PUBLIC (game scores / leaderboard — visible to every
 * player in-app), so no `staging:private` marker. Staging seeds obvious
 * "demo_*" players via seedDemo() so the board is reviewable.
 */

"use strict";

// ── Tunable scoring weights ──────────────────────────────────────────
// First-guess defaults; safe to retune — scores rebuild from chain on
// the next boot, so a weight change is non-breaking.
const DRAW_BONUS = 50;          // flat points per recorded drawing
const SPECIES_BONUS = 100;      // one-time points the first time an element is used
const STREAK_BONUS_PER_DAY = 25; // multiplied by the player's best daily streak

// Element Collector target: distinct non-erase elements in the palette.
// Informational only (the client renders progress against its own SPECIES
// list); kept here so the server can flag the badge.
const SPECIES_TOTAL = 30;

// Cumulative painted-area milestones (badge thresholds).
const PIXEL_MILESTONES = [1000, 10000, 100000];

const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 450;
const DAY_MS = 86400000;
const DEFAULT_DEBOUNCE_MS = 5000;

// Sender labels that aren't real players (engine fallbacks) — never ranked.
const EXCLUDED_SENDERS = new Set(["unknown", "chain", ""]);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sands_scores (
    pubkey        TEXT PRIMARY KEY,
    score         BIGINT NOT NULL,
    pixels        BIGINT NOT NULL,
    draws         INTEGER NOT NULL,
    species_mask  BIGINT NOT NULL,
    daily_points  BIGINT NOT NULL,
    day_key       TEXT,
    streak_days   INTEGER NOT NULL,
    best_streak   INTEGER NOT NULL,
    first_ts      BIGINT,
    last_ts       BIGINT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

// ── Pure scoring helpers (exported for tests) ────────────────────────

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// UTC day key "YYYY-MM-DD" for a ms timestamp.
function dayKeyOf(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Integer UTC day index (days since epoch) for a "YYYY-MM-DD" key.
function dayIndexOf(key) {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/**
 * Score a single draw memo. Returns `null` for anything that isn't a
 * well-formed falling-sands draw (resets, malformed memos). For a valid
 * draw — including an erase-only one — returns { area, species }, where
 * `species` is the Set of distinct NON-erase element ids painted and
 * `area` is the painted area (0 for erase-only).
 *
 * The area formula mirrors the client's per-stroke budget math
 * (public/index.html segmentArea): len*r*2 + π*r². Size is clamped to
 * the engine's [1,20] paint range and coordinates to the canvas, so a
 * hand-crafted oversized memo can't inflate score beyond what the engine
 * would actually paint.
 */
function scoreDrawMemo(memo, width, height) {
  if (!memo || memo.app !== "falling-sands" || memo.type !== "draw" || !Array.isArray(memo.s)) {
    return null;
  }
  const W = width || DEFAULT_WIDTH;
  const H = height || DEFAULT_HEIGHT;
  let area = 0;
  const species = new Set();
  for (const seg of memo.s) {
    if (!Array.isArray(seg) || seg.length < 6) continue;
    const sp = seg[5] | 0;
    if (sp === 0) continue; // erase earns nothing and isn't a discovery
    const r = clamp(seg[4] | 0, 1, 20);
    const x1 = clamp(seg[0] | 0, 0, W - 1);
    const y1 = clamp(seg[1] | 0, 0, H - 1);
    const x2 = clamp(seg[2] | 0, 0, W - 1);
    const y2 = clamp(seg[3] | 0, 0, H - 1);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    area += len * r * 2 + Math.PI * r * r;
    species.add(sp);
  }
  return { area, species };
}

// Longest + currently-alive consecutive-day streaks from a Set of UTC
// day keys. "Alive" = the latest active day is today or yesterday
// relative to `nowMs`; otherwise the visible (current) streak is 0.
function computeStreaks(daysSet, nowMs) {
  if (!daysSet || daysSet.size === 0) return { best: 0, current: 0 };
  const idx = Array.from(daysSet, dayIndexOf).sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  let tail = 1;
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] === idx[i - 1] + 1) {
      run++;
    } else if (idx[i] !== idx[i - 1]) {
      run = 1;
    }
    if (run > best) best = run;
  }
  for (let i = idx.length - 1; i > 0; i--) {
    if (idx[i] === idx[i - 1] + 1) tail++;
    else break;
  }
  const todayIdx = Math.floor(nowMs / DAY_MS);
  const lastIdx = idx[idx.length - 1];
  const alive = lastIdx === todayIdx || lastIdx === todayIdx - 1;
  return { best, current: alive ? tail : 0 };
}

function speciesMaskOf(speciesSet) {
  let mask = 0;
  for (const s of speciesSet) mask += Math.pow(2, s);
  return mask;
}

function badgesFor(row) {
  const badges = [];
  let milestone = 0;
  for (const m of PIXEL_MILESTONES) if (row.pixels >= m) milestone = m;
  if (milestone) badges.push("pixels:" + milestone);
  if (row.species >= SPECIES_TOTAL) badges.push("collector");
  if (row.streakDays >= 2) badges.push("streak:" + row.streakDays);
  return badges;
}

// ── Store factory ────────────────────────────────────────────────────

function createLeaderboardStore(opts) {
  opts = opts || {};
  const width = opts.width || DEFAULT_WIDTH;
  const height = opts.height || DEFAULT_HEIGHT;
  const debounceMs = opts.debounceMs || DEFAULT_DEBOUNCE_MS;
  let chainId = opts.chainId || null;

  // pubkey -> aggregate
  const players = new Map();
  // de-dup guard: tx ids already counted (defense-in-depth; the live
  // cache also seeds initialSeenIds so boot-counted txs aren't redelivered)
  const seen = new Set();

  // ── Postgres mirror (optional) ────────────────────────────────────
  let pool = null;
  let pgDegraded = false;
  let migrated = false;
  const dirty = new Set();
  let debounceTimer = null;
  let inFlight = null;

  if (opts.databaseUrl) {
    try {
      const pg = require("pg");
      pool = new pg.Pool({
        connectionString: opts.databaseUrl,
        max: 2,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      });
    } catch (e) {
      console.warn(`[leaderboard] 'pg' unavailable (${e.message}) — memory-only`);
      pgDegraded = true;
    }
  } else {
    console.warn("[leaderboard] DATABASE_URL unset — running memory-only (rebuilt from chain each boot)");
    pgDegraded = true;
  }

  // ── tx field extraction ───────────────────────────────────────────
  function txIdOf(raw) {
    return raw.tx_id || raw.id || raw.txid || null;
  }
  function senderOf(raw) {
    return raw.source || raw.from_pubkey || raw.from || raw.fromPubkey || "unknown";
  }
  function timestampOf(raw) {
    if (raw.timestamp_ms) return raw.timestamp_ms;
    if (raw.created_at) {
      const t = Date.parse(raw.created_at);
      if (!Number.isNaN(t)) return t;
    }
    return Date.now();
  }
  function memoOf(raw) {
    if (!raw.memo) return null;
    try {
      return typeof raw.memo === "string" ? JSON.parse(raw.memo) : raw.memo;
    } catch (_) {
      return null;
    }
  }

  function getOrCreate(pubkey) {
    let p = players.get(pubkey);
    if (!p) {
      p = {
        pubkey,
        pixels: 0,
        draws: 0,
        basePoints: 0,
        speciesSeen: new Set(),
        days: new Set(),
        firstTs: 0,
        lastTs: 0,
        dayKey: null,
        dayPoints: 0,
      };
      players.set(pubkey, p);
    }
    return p;
  }

  /**
   * Ingest one raw chain/mock transaction. Idempotent by tx id. No-op
   * for non-draw memos and excluded senders. Pure aggregation — never
   * touches the engine.
   */
  function ingest(raw) {
    if (!raw) return;
    const id = txIdOf(raw);
    if (id && seen.has(id)) return;
    const memo = memoOf(raw);
    const ds = scoreDrawMemo(memo, width, height);
    if (!ds) return; // not a draw (reset / malformed) — ignored for scoring
    const from = senderOf(raw);
    if (!from || EXCLUDED_SENDERS.has(from)) return;
    if (id) seen.add(id);

    const ts = timestampOf(raw);
    const p = getOrCreate(from);

    let newSpecies = 0;
    for (const s of ds.species) {
      if (!p.speciesSeen.has(s)) {
        p.speciesSeen.add(s);
        newSpecies++;
      }
    }
    const pixels = Math.round(ds.area);
    const pd = pixels + DRAW_BONUS + SPECIES_BONUS * newSpecies;

    p.pixels += pixels;
    p.draws += 1;
    p.basePoints += pd;

    const dk = dayKeyOf(ts);
    p.days.add(dk);
    // "Today" bucket tracks the player's most-recent active day; the
    // endpoint only surfaces it when that day === the actual current day.
    if (!p.dayKey || dk > p.dayKey) {
      p.dayKey = dk;
      p.dayPoints = 0;
    }
    if (dk === p.dayKey) p.dayPoints += pd;

    if (!p.firstTs || ts < p.firstTs) p.firstTs = ts;
    if (ts > p.lastTs) p.lastTs = ts;

    markDirty(from);
  }

  function ingestAll(txs) {
    if (!Array.isArray(txs)) return;
    for (const tx of txs) ingest(tx);
  }

  // ── Row assembly ──────────────────────────────────────────────────
  function rowOf(p, nowMs) {
    const streaks = computeStreaks(p.days, nowMs);
    // Bonus grows with the best run of consecutive days. A lone day isn't
    // a streak, so it starts paying out at 2 days (best - 1).
    const score = p.basePoints + STREAK_BONUS_PER_DAY * Math.max(0, streaks.best - 1);
    const todayKey = dayKeyOf(nowMs);
    const dailyPoints = p.dayKey === todayKey ? p.dayPoints : 0;
    const row = {
      pubkey: p.pubkey,
      score,
      dailyPoints,
      pixels: p.pixels,
      draws: p.draws,
      species: p.speciesSeen.size,
      streakDays: streaks.current,
      bestStreak: streaks.best,
      firstTs: p.firstTs,
      lastTs: p.lastTs,
    };
    row.badges = badgesFor(row);
    return row;
  }

  /**
   * Build the leaderboard payload.
   *   scope: "all" (default, ranks by all-time score) | "daily" (ranks by
   *          points earned in the current UTC day, players with 0 dropped)
   *   limit: max rows in `top` (default 100)
   *   me:    caller's pubkey; if present and ranked, returns their `you` row
   */
  function getLeaderboard(o) {
    o = o || {};
    const scope = o.scope === "daily" ? "daily" : "all";
    const limit = o.limit || 100;
    const me = o.me || null;
    const nowMs = o.now || Date.now();

    let rows = [];
    for (const p of players.values()) {
      if (EXCLUDED_SENDERS.has(p.pubkey)) continue;
      rows.push(rowOf(p, nowMs));
    }

    if (scope === "daily") {
      rows = rows.filter((r) => r.dailyPoints > 0);
      rows.sort(
        (a, b) =>
          b.dailyPoints - a.dailyPoints ||
          b.score - a.score ||
          (a.pubkey < b.pubkey ? -1 : 1)
      );
    } else {
      rows.sort(
        (a, b) =>
          b.score - a.score ||
          b.pixels - a.pixels ||
          (a.pubkey < b.pubkey ? -1 : 1)
      );
    }

    rows.forEach((r, i) => {
      r.rank = i + 1;
    });

    const top = rows.slice(0, limit);
    let you = null;
    if (me) {
      const mine = rows.find((r) => r.pubkey === me);
      if (mine) you = mine;
    }

    return {
      scope,
      updatedAt: nowMs,
      totalPlayers: rows.length,
      top,
      you,
    };
  }

  // ── Postgres flush ────────────────────────────────────────────────
  function markDirty(pubkey) {
    if (pgDegraded) return;
    dirty.add(pubkey);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (pgDegraded || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush().catch((e) => console.warn(`[leaderboard] flush failed (${e.message})`));
    }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  async function ensureSchema() {
    if (migrated || pgDegraded) return;
    await pool.query(SCHEMA_SQL);
    migrated = true;
  }

  async function flush() {
    if (pgDegraded || dirty.size === 0) return;
    if (inFlight) {
      await inFlight.catch(() => {});
      if (dirty.size === 0) return;
    }
    const batch = Array.from(dirty);
    dirty.clear();
    const nowMs = Date.now();
    inFlight = (async () => {
      try {
        await ensureSchema();
        for (const pubkey of batch) {
          const p = players.get(pubkey);
          if (!p) continue;
          const r = rowOf(p, nowMs);
          await pool.query(
            `INSERT INTO sands_scores
               (pubkey, score, pixels, draws, species_mask, daily_points,
                day_key, streak_days, best_streak, first_ts, last_ts, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
             ON CONFLICT (pubkey) DO UPDATE SET
               score = EXCLUDED.score,
               pixels = EXCLUDED.pixels,
               draws = EXCLUDED.draws,
               species_mask = EXCLUDED.species_mask,
               daily_points = EXCLUDED.daily_points,
               day_key = EXCLUDED.day_key,
               streak_days = EXCLUDED.streak_days,
               best_streak = EXCLUDED.best_streak,
               first_ts = EXCLUDED.first_ts,
               last_ts = EXCLUDED.last_ts,
               updated_at = NOW()`,
            [
              p.pubkey,
              r.score,
              r.pixels,
              r.draws,
              speciesMaskOf(p.speciesSeen),
              r.dailyPoints,
              p.dayKey,
              r.streakDays,
              r.bestStreak,
              p.firstTs || null,
              p.lastTs || null,
            ]
          );
        }
      } catch (e) {
        // Re-queue so a transient failure doesn't lose updates.
        for (const k of batch) dirty.add(k);
        throw e;
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  /** Ensure schema exists (run once at boot, before backfill). */
  async function init() {
    if (pgDegraded) return;
    try {
      await ensureSchema();
    } catch (e) {
      console.warn(`[leaderboard] schema init failed (${e.message}) — memory-only`);
      pgDegraded = true;
    }
  }

  /** Enable debounced flushing after boot backfill has populated memory. */
  function start() {
    if (!pgDegraded && dirty.size > 0) scheduleFlush();
  }

  /** SIGTERM: drain debounce + finish any in-flight write. */
  async function flushNow() {
    if (pgDegraded) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      await flush();
    } catch (e) {
      console.warn(`[leaderboard] final flush failed (${e.message})`);
    }
    try {
      await pool.end();
    } catch (_) {}
  }

  /**
   * Chain swap (different chain_id) — wipe everything and replay from the
   * new chain. An admin *reset* (same chain) must NOT call this: it wipes
   * pixels, not lifetime contribution.
   */
  function onChainReset(newId, oldId) {
    if (newId && oldId && newId === oldId) return;
    console.log(`[leaderboard] chain reset ${oldId} -> ${newId} — clearing scores`);
    players.clear();
    seen.clear();
    dirty.clear();
    chainId = newId || null;
    if (!pgDegraded) {
      pool
        .query("DELETE FROM sands_scores")
        .catch((e) => console.warn(`[leaderboard] clear failed (${e.message})`));
    }
  }

  /**
   * Staging/local demo seed. Builds obviously-fake "demo_*" players via
   * synthetic draw transactions run through the REAL scoring path, so the
   * board is reviewable where the chain has no (or little) history. Stable
   * ids make it idempotent; memory is rebuilt fresh each boot anyway.
   * Gated by the caller on USERNODE_ENV === 'staging' || --local-dev.
   */
  function seedDemo(nowMs) {
    const now = nowMs || Date.now();
    // Pubkeys end in a readable suffix so the username fallback reads as
    // "user_demo01" etc. (last6 of the pubkey).
    const mk = (suffix) => "ut1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" + suffix;
    const seg = (x1, y1, x2, y2, size, sp) => [x1, y1, x2, y2, size, sp];
    const DAY = DAY_MS;
    let n = 0;
    const tx = (pubkey, dayAgo, segs) => ({
      tx_id: "demo-tx-" + n++,
      source: pubkey,
      timestamp_ms: now - dayAgo * DAY + 3600000,
      memo: { app: "falling-sands", type: "draw", s: segs },
    });

    const demo = [];
    // Pixel-Pete — big areas, several elements, drew today (daily leader).
    const pete = mk("demo01");
    demo.push(tx(pete, 0, [seg(20, 20, 280, 400, 12, 2), seg(40, 60, 240, 300, 10, 3)]));
    demo.push(tx(pete, 0, [seg(10, 10, 120, 200, 8, 8), seg(150, 50, 280, 420, 9, 6)]));
    demo.push(tx(pete, 1, [seg(30, 30, 200, 380, 10, 13)]));

    // Streak-Sue — drew every day for the last 5 days (streak + bonus).
    const sue = mk("demo02");
    for (let d = 0; d < 5; d++) {
      demo.push(tx(sue, d, [seg(50 + d * 10, 40, 200, 360, 5, 11 + d)]));
    }

    // Collector-Cleo — uses every distinct non-erase element (earns the
    // Element Collector 🏆 badge). Split across two draws to respect the
    // engine's per-draw memo budget shape.
    const cleo = mk("demo03");
    const allElems = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    ];
    const half = Math.ceil(allElems.length / 2);
    demo.push(
      tx(cleo, 2, allElems.slice(0, half).map((sp, i) => seg(10 + i * 12, 30, 18 + i * 12, 110, 3, sp)))
    );
    demo.push(
      tx(cleo, 1, allElems.slice(half).map((sp, i) => seg(10 + i * 12, 140, 18 + i * 12, 220, 3, sp)))
    );

    // A couple of small contributors for a fuller board.
    demo.push(tx(mk("demo04"), 0, [seg(100, 100, 140, 160, 4, 4)]));
    demo.push(tx(mk("demo05"), 3, [seg(60, 200, 90, 260, 3, 19)]));
    demo.push(tx(mk("demo06"), 6, [seg(200, 50, 230, 90, 5, 17)]));

    ingestAll(demo);
    console.log(`[leaderboard] seeded ${demo.length} demo draw(s) across 6 demo players`);
  }

  return {
    ingest,
    ingestAll,
    getLeaderboard,
    init,
    start,
    flushNow,
    onChainReset,
    seedDemo,
    // exposed for tests / introspection
    _players: players,
  };
}

module.exports = {
  createLeaderboardStore,
  // pure helpers exported for tests
  scoreDrawMemo,
  computeStreaks,
  dayKeyOf,
  dayIndexOf,
  speciesMaskOf,
  DRAW_BONUS,
  SPECIES_BONUS,
  STREAK_BONUS_PER_DAY,
};
