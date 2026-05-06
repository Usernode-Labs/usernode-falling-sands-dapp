/**
 * Postgres-backed mirror of the engine's on-disk snapshot.json.
 *
 * Engine.js writes a single snapshot.json to SNAPSHOT_DIR on freeze
 * events and roughly every 2 hours during active windows. On Social
 * Vibecoding deploys, container disks are ephemeral, so every cold
 * boot would replay the entire chain history from genesis without
 * persistence — minutes of compute on first paint.
 *
 * This module bridges the on-disk snapshot to a single BYTEA row in
 * the per-app Postgres database SV auto-provisions (DATABASE_URL is
 * pre-injected into the container env). The engine itself remains
 * byte-identical to upstream — it still just reads/writes
 * snapshot.json. This module:
 *
 *   .hydrate()    — on boot, SELECT snapshot row from Postgres and
 *                   write it to SNAPSHOT_DIR/snapshot.json so the
 *                   engine finds it on its first read.
 *   .start()      — fs.watch SNAPSHOT_DIR; on snapshot.json change,
 *                   debounce 5s, then INSERT … ON CONFLICT DO UPDATE.
 *   .flushNow()   — drain any pending debounced write synchronously.
 *                   Called from SIGTERM so we don't lose the last
 *                   write at shutdown.
 *
 * If DATABASE_URL is unset (running outside SV) or Postgres is
 * unreachable at startup, every method becomes a no-op and we log a
 * one-shot warning. The dapp still works — it just falls back to
 * disk-only durability, which on SV means "ephemeral".
 *
 * Schema (idempotent, run on first .hydrate()):
 *
 *   CREATE TABLE IF NOT EXISTS sands_state (
 *     key        TEXT PRIMARY KEY,
 *     data       BYTEA NOT NULL,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * The schema has room for additional keys (e.g. 'chain-info') but
 * the engine only writes snapshot.json today, so we use a single
 * 'snapshot' row. ~120 KB compressed (zlib level 1, 3 buffers ×
 * WIDTH × HEIGHT bytes) — comfortable for BYTEA.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DEBOUNCE_MS = 5000;
const SNAPSHOT_KEY = "snapshot";
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sands_state (
    key        TEXT PRIMARY KEY,
    data       BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function createSnapshotStore(opts) {
  const databaseUrl = opts && opts.databaseUrl;
  const snapshotDir = (opts && opts.snapshotDir) || path.join(process.cwd(), "data");
  const debounceMs = (opts && opts.debounceMs) || DEFAULT_DEBOUNCE_MS;

  if (!databaseUrl) {
    console.warn(
      "[snapshot-store] DATABASE_URL unset — running disk-only. Cold boots will replay from chain."
    );
    return makeNoopStore();
  }

  let pg;
  try {
    pg = require("pg");
  } catch (e) {
    console.warn(
      `[snapshot-store] 'pg' module not installed (${e.message}) — running disk-only.`
    );
    return makeNoopStore();
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Snapshot writes are tiny and infrequent; one connection is plenty.
    max: 2,
    // Don't keep a connection open between writes — saves a slot in
    // the shared SV postgres while idle.
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  let watcher = null;
  let debounceTimer = null;
  let pending = false;          // a write is queued for the next debounce tick
  let inFlight = null;          // current Promise of an INSERT in progress
  let degraded = false;         // pg unreachable — give up trying for the rest of this run
  let migrated = false;
  let started = false;

  /**
   * Ensure the schema exists. Idempotent.
   */
  async function ensureSchema() {
    if (migrated) return;
    await pool.query(SCHEMA_SQL);
    migrated = true;
  }

  /**
   * Run on boot before the engine reads snapshot.json from disk.
   *
   * 1. Ensure SNAPSHOT_DIR exists.
   * 2. CREATE TABLE IF NOT EXISTS.
   * 3. SELECT the snapshot row (if any) and atomically write it to
   *    SNAPSHOT_DIR/snapshot.json so the engine sees it on its first
   *    read.
   *
   * Throws nothing on Postgres failure — degrades to disk-only and
   * logs a warning. The engine will then either find an existing
   * disk snapshot (if any) or replay from chain.
   */
  async function hydrate() {
    try {
      if (!fs.existsSync(snapshotDir)) {
        fs.mkdirSync(snapshotDir, { recursive: true });
      }
      await ensureSchema();
      const result = await pool.query(
        "SELECT data, updated_at FROM sands_state WHERE key = $1",
        [SNAPSHOT_KEY]
      );
      if (result.rowCount === 0) {
        console.log("[snapshot-store] no existing snapshot in Postgres — engine will replay or use disk fallback");
        return;
      }
      const row = result.rows[0];
      const buf = row.data; // pg returns BYTEA as a Node Buffer
      // Atomic write so the engine never reads a partial file: write
      // to .tmp first, then rename.
      const target = path.join(snapshotDir, "snapshot.json");
      const tmp = target + ".tmp";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
      console.log(
        `[snapshot-store] hydrated ${buf.length} bytes from Postgres (updated_at=${row.updated_at.toISOString()})`
      );
    } catch (e) {
      console.warn(`[snapshot-store] hydrate failed (${e.message}) — disk-only fallback`);
      degraded = true;
    }
  }

  /**
   * Watch SNAPSHOT_DIR for snapshot.json changes and mirror them to
   * Postgres with debounce. Engine writes are infrequent (every 2h
   * active, plus on freeze) so a 5s debounce comfortably absorbs
   * any save-then-fsync flutter without delaying durability.
   */
  function start() {
    if (started || degraded) return;
    started = true;
    try {
      watcher = fs.watch(snapshotDir, { persistent: false }, (eventType, filename) => {
        if (filename !== "snapshot.json") return;
        scheduleSync();
      });
      console.log(`[snapshot-store] watching ${snapshotDir} for snapshot.json changes`);
    } catch (e) {
      console.warn(
        `[snapshot-store] fs.watch failed (${e.message}) — disk-only fallback (engine writes won't reach Postgres)`
      );
      degraded = true;
    }
  }

  function scheduleSync() {
    pending = true;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSync().catch((e) => {
        console.warn(`[snapshot-store] sync failed (${e.message})`);
      });
    }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  async function runSync() {
    if (!pending || degraded) return;
    pending = false;
    if (inFlight) {
      // A prior write is still in flight — wait for it then re-check
      // pending (the watcher may have set it again in the meantime).
      try {
        await inFlight;
      } catch (_) {}
      if (pending) return runSync();
      return;
    }

    const filePath = path.join(snapshotDir, "snapshot.json");
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (e) {
      console.warn(`[snapshot-store] cannot read ${filePath}: ${e.message}`);
      return;
    }

    inFlight = (async () => {
      try {
        await ensureSchema();
        await pool.query(
          `INSERT INTO sands_state (key, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data,
                 updated_at = NOW()`,
          [SNAPSHOT_KEY, buf]
        );
        console.log(`[snapshot-store] wrote ${buf.length} bytes to Postgres`);
      } finally {
        inFlight = null;
      }
    })();

    await inFlight;
    if (pending) return runSync(); // another write came in while we were committing
  }

  /**
   * Synchronous flush for SIGTERM. Drains the debounce timer and
   * waits for any in-flight write before resolving. Best-effort:
   * if Postgres is slow, the container will be killed by Docker's
   * default 10s grace anyway.
   */
  async function flushNow() {
    if (degraded) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      pending = true;
    }
    try {
      await runSync();
    } catch (e) {
      console.warn(`[snapshot-store] flush failed (${e.message})`);
    }
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      watcher = null;
    }
    try { await pool.end(); } catch (_) {}
  }

  return { hydrate, start, flushNow };
}

function makeNoopStore() {
  return {
    hydrate: async () => {},
    start: () => {},
    flushNow: async () => {},
  };
}

module.exports = { createSnapshotStore };
