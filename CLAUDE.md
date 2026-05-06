# Falling Sands — notes for Claude Code

A collaborative on-chain pixel sandbox on the Usernode chain. Users send
draw transactions to the canvas address; the server runs a deterministic
Rust+WASM physics simulation against the chain's transaction history and
streams snapshots/state updates to connected clients via WebSocket.
Clients run the same WASM build locally for rendering — the on-chain
transaction stream is the single source of truth.

This app runs as a child app inside Usernode Social Vibecoding. Read the
authoritative platform conventions before making changes:

**Platform conventions (always current):**
https://usernode.evanshapiro.dev/claude.md

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win.

## Architecture

- `server.js` — Express server. Mock API (--local-dev), engine state
  endpoints, explorer proxy, static `public/`, WebSocket relay,
  Postgres-backed snapshot persistence. No auth middleware (falling-sands
  is public — see "Auth model" below).
- `engine.js` — Vendored byte-identical from upstream. Owns the WASM
  simulation, windowed deterministic replay against chain history,
  on-disk snapshot lifecycle, WebSocket fan-out. Do **not** edit in-place
  — re-vendor from `usernode-dapp-starter/examples/falling-sands` when
  upstream lands fixes.
- `seed-content.js`, `wasm-loader.js`, `wasm-browser.js` — Vendored
  byte-identical helpers used by `engine.js` and the browser client.
  Same re-vendor rule.
- `lib/dapp-server.js` — Vendored helpers (mock API, chain poller,
  explorer proxy, env loader, status probe, status page,
  `fetchAllTransactions`, `discoverChainInfo`). Re-vendor from
  `usernode-dapp-starter` when upstream changes.
- `lib/tx-match.js` — Vendored helper used by `lib/dapp-server.js`. Same
  re-vendor rule.
- `lib/snapshot-store.js` — **Local to this repo.** Bridges the engine's
  on-disk `snapshot.json` to a Postgres row in `sands_state`. Hydrates
  disk from Postgres on boot, mirrors disk writes back via a debounced
  `fs.watch`, flushes on `SIGTERM`. Engine.js is unaware of Postgres.
- `sandspiel/` — Git submodule (HTTPS,
  `https://github.com/Usernode-Labs/sandspiel.git`, pinned to
  `347caa64`). The `crate/` subdirectory is the Rust+WASM physics engine
  source; the Dockerfile compiles it via `wasm-pack`.
- `public/` — Browser UI (single HTML file, plus the shared
  `usernode-bridge.js`, `usernode-usernames.js`, `usernode-loading.js`).
  The bridge and loader are shared infrastructure; do not fork them
  per-app.
- `tests/` — Vendored determinism / multi-server / replay tests. Run
  with `node tests/<file>.js` once `pkg/` is built.

## Running locally

```bash
git submodule update --init --recursive   # populate sandspiel/
cd sandspiel && wasm-pack build crate --target nodejs && cd ..
npm install
npm run dev                                # mock mode, http://localhost:3000
npm start                                  # production mode (requires .env)
```

The submodule + WASM build are one-time setup; subsequent runs are just
`npm run dev` / `npm start`.

## Auth model

Falling-sands is **public**. There is no JWT, no platform login required,
no `req.user` consulted anywhere. The HTTP surface (snapshot, transactions
log, state) is read-only from the client's perspective. Wallet operations
(draw transactions) are signed client-side via `usernode-bridge.js`,
which has three modes and picks one automatically:

- **Native (top frame in Flutter WebView)** — the Usernode mobile app
  injects a `Usernode` JS channel; the bridge detects via
  `!!window.Usernode` and routes `sendTransaction` through the channel.
- **Iframe-relay (falling-sands embedded inside another page that has
  the native channel)** — the bridge posts a `discover` message to
  `window.parent`; if the parent ACKs, the child flips into relay mode
  and round-trips its native calls through the parent's
  `Usernode.postMessage`.
- **QR fallback (desktop browser, no native channel anywhere in the
  frame stack)** — `sendTransaction` shows a QR code for the user to
  scan with the Usernode mobile app, then polls for inclusion.

The server never holds an `APP_SECRET_KEY`; it doesn't need to send
transactions on behalf of the canvas. (Contrast lastwin / echo, which
do hold a secret for payouts / echoes.)

## Memo schema

Memos are JSON. Falling-sands acts on:

- `user → canvas (draw)`: `{"app":"falling-sands","type":"draw","points":[{x,y,species}…]}`
  — applied to the simulation in tx order at the corresponding tick.
- `admin → canvas (reset)`: `{"app":"falling-sands","type":"reset"}` —
  resets the canvas. Honored only when the sender pubkey matches
  `ADMIN_PUBKEY`. Any reset from a different sender is silently ignored
  in both live and replay paths (see `engine.js`).

## Sidecar dependency

Falling-sands does **not** call `/wallet/send` — it never sends
transactions. The sidecar is only needed for the optional direct-to-node
live tail (see next section). With `USE_NODE_STREAM=0` (or unset on a
sidecar that doesn't expose the recent-tx-stream endpoints) the engine
runs purely off the explorer.

## Direct-to-node live tail (opt-in)

Set `USE_NODE_STREAM=1` in `.env` to bypass the explorer's 5–60s
indexing lag for live transaction delivery. The cache replaces the
explorer poller for the `recipient` queryField with
`createNodeRecentTxStream` (SSE + catch-up poll against the sidecar's
`/transactions/stream` and `/transactions/by_recipient` endpoints).
Backfill is engine-owned (windowed replay) and stays explorer-driven via
`fetchAllTransactions` — see the async init() IIFE in `server.js`.

## Persistence

The engine writes a single `snapshot.json` to `SNAPSHOT_DIR` on freeze
events and roughly every 2 hours during active windows. Without
intervention this is ephemeral on Social Vibecoding deploys (containers
have no persistent volumes), so every cold boot would replay the entire
chain history from genesis — minutes of compute on first paint.

`lib/snapshot-store.js` solves this by mirroring `snapshot.json` to a
single-row `BYTEA` column in the per-app Postgres database SV
auto-provisions (`DATABASE_URL` is auto-injected into the container
env). The flow:

1. **Boot**: store hydrates `snapshot.json` from Postgres before the
   engine reads it from disk.
2. **Runtime**: store watches `SNAPSHOT_DIR` with a 5s debounce; on
   change, reads the file and `INSERT … ON CONFLICT DO UPDATE` into
   Postgres.
3. **Shutdown**: `SIGTERM` triggers a synchronous flush before exit.

Engine.js is unaware of any of this — it still just reads/writes
`snapshot.json`. If `DATABASE_URL` is unset (e.g. running outside SV)
the store logs a warning and falls back to disk-only persistence.

Schema:

```sql
CREATE TABLE IF NOT EXISTS sands_state (
  key        TEXT PRIMARY KEY,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Single row keyed `'snapshot'`. ~120 KB compressed.

## Submodule note

`sandspiel/` is a git submodule pointing at the public
`Usernode-Labs/sandspiel` repo via HTTPS so the SV build container (which
has no SSH keys) can clone it. Social Vibecoding's `app-creator.js`
clones with `--recurse-submodules --shallow-submodules`, so the
submodule is populated automatically at deploy time. When working
locally, run `git submodule update --init --recursive` after cloning.

## App-specific conventions

- The on-chain transaction stream is the single source of truth. The
  server's job is to apply transactions to the simulation deterministically
  and stream the result; it never originates state.
- `engine.js` and the browser client run the same WASM module. They must
  produce bit-identical pixel buffers for any (chain_id, epoch,
  transaction stream) tuple. Tests in `tests/` exercise this property.
- Snapshot poisoning defense: the engine refuses to load a snapshot
  whose `chain_id` or `epoch` doesn't match the current chain. A chain
  reset (different chain_id) auto-clears the snapshot via
  `engineCache.onChainReset` and replays from genesis.
- `/__sands/state`, `/__sands/snapshot`, `/__sands/transactions` are
  intentionally public. They expose global state identical for every
  viewer.

## Parallel deploys + same APP_PUBKEY

Both this repo and `usernode-dapp-starter`'s combined examples server
deploy independently and share the same `APP_PUBKEY`. They both observe
the same chain history and converge on the same simulation state — no
race like lastwin's payout race, because falling-sands never originates
transactions. The two simulations may briefly disagree during a chain
reorg before each catches up, but they're always headed for the same
canonical state.
