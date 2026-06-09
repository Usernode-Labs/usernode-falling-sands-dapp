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
- `wasm/crate/` — **In-repo, tracked** Rust+WASM physics engine source
  (originally from `Usernode-Labs/sandspiel`, now vendored here). The
  Dockerfile compiles it via `wasm-pack` at deploy time. This replaces the
  old `sandspiel/` git submodule: the submodule was removed because new
  species code (the electricity/automation system) had to live in commits
  that could not be pushed to the external sandspiel remote from the deploy
  worker, which broke the `--recurse-submodules` clone. Editing the Rust now
  means editing `wasm/crate/src/{lib,species,utils}.rs` directly and
  committing — no external repo, no submodule pin to bump.
- `public/` — Browser UI (single HTML file, plus the shared
  `usernode-usernames.js` and `usernode-loading.js`). The bridge is loaded
  from `https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js` —
  canonical source lives in the social-vibecoding repo at
  `public/usernode-bridge/v1/bridge.js`. Never vendor it per-app; bridge
  fixes ship from one SV redeploy, fleet-wide. The loader is still
  shared infrastructure; do not fork it per-app.
- `tests/` — Vendored determinism / multi-server / replay tests. Run
  with `node tests/<file>.js` once `pkg/` is built.

## Running locally

```bash
cd wasm && wasm-pack build crate --target nodejs && cd ..   # builds wasm/crate/pkg/
# copy the built pkg to the runtime path the loaders read:
mkdir -p sandspiel/crate && cp -r wasm/crate/pkg sandspiel/crate/pkg
npm install
npm run dev                                # mock mode, http://localhost:3000
npm start                                  # production mode (requires .env)
```

The WASM build is one-time setup; subsequent runs are just
`npm run dev` / `npm start`. (The Dockerfile does the build + copy
automatically — see its two stages.) The runtime pkg path
`sandspiel/crate/pkg/` is retained only so `wasm-loader.js` and
`server.js` need no change; the *source* lives at `wasm/crate/`.

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

## WASM crate source (no submodule)

The physics engine Rust source is **vendored in-repo at `wasm/crate/`** and
tracked normally — there is no git submodule anymore. The previous
`sandspiel/` submodule (pinned to `Usernode-Labs/sandspiel`) was removed:
because the deploy worker has no GitHub credentials it cannot push new
commits to that external repo, so any submodule pin referencing locally-made
species changes (the electricity/automation system) was unreachable and the
platform's `--recurse-submodules --shallow-submodules` clone failed before
the Docker build even ran.

Now the Dockerfile's stage 1 does `COPY wasm/ wasm/` and `wasm-pack build
crate`, building straight from tracked repo source in the build context — no
network clone, no external pin. To change the simulation, edit
`wasm/crate/src/*.rs` and commit; the next deploy rebuilds the WASM. If
upstream `sandspiel` lands fixes worth taking, re-vendor by copying its
`crate/src` files into `wasm/crate/src` (the inverse of the old "re-vendor
from upstream" rule).

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
- **Replay-trim optimization**: `server.js`'s `trimToLatestAdminReset`
  drops every fetched tx older than the most recent admin-authored
  reset memo before passing the list to `createEngine({replayTxs})`.
  Each reset wipes the canvas via `reseedUniverse()`, so any pre-reset
  draws applied during replay are immediately discarded — trimming
  saves the (potentially large) windowed-physics simulation cost on
  cold boots when the chain has accumulated a long pre-reset history.
  Safe because (a) `reseedUniverse()` is idempotent and (b) the engine
  still applies its own `txTick <= tickCount` filter, so a snapshot
  newer than the latest reset transparently drops the (now-redundant)
  reset event. Only kicks in when `ADMIN_PUBKEY` is set.

## Parallel deploys + same APP_PUBKEY

Both this repo and `usernode-dapp-starter`'s combined examples server
deploy independently and share the same `APP_PUBKEY`. They both observe
the same chain history and converge on the same simulation state — no
race like lastwin's payout race, because falling-sands never originates
transactions. The two simulations may briefly disagree during a chain
reorg before each catches up, but they're always headed for the same
canonical state.
