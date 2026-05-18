# Falling Sands

A collaborative on-chain pixel sandbox on the Usernode chain. Users send
draw transactions to the canvas address; a server-side Rust+WASM physics
simulation applies them deterministically against the chain's transaction
history and streams snapshots/state updates to connected browsers via
WebSocket. Browsers run the same WASM build locally for rendering.

Designed to run as a child app inside Usernode Social Vibecoding, but
also works standalone (mobile WebView or desktop QR) when fronted by a
node.

## Quick start

```bash
git submodule update --init --recursive
cd sandspiel && wasm-pack build crate --target nodejs && cd ..
npm install
npm run dev          # mock mode at http://localhost:3000
```

For production:

```bash
cp .env.example .env # fill in APP_PUBKEY (and DATABASE_URL if running outside SV)
npm start
```

## Layout

```
falling-sands/
  server.js              Express server: WebSocket, engine state APIs,
                         explorer proxy, static, snapshot persistence.
  engine.js              Vendored from upstream. WASM simulation,
                         windowed deterministic replay, snapshot
                         lifecycle, WebSocket fan-out. Do NOT edit;
                         re-vendor when upstream changes.
  seed-content.js        Vendored. Initial cell layout.
  wasm-loader.js         Vendored. Node.js WASM loader for the engine.
  wasm-browser.js        Vendored. Browser WASM loader (served at /wasm-browser.js).
  lib/
    dapp-server.js       Vendored helpers from usernode-dapp-starter.
    tx-match.js          Vendored helper used by dapp-server.js.
    snapshot-store.js    LOCAL. Postgres ↔ on-disk snapshot bridge.
  sandspiel/             Submodule (HTTPS, pinned). Rust+WASM source.
  public/
    index.html
    usernode-usernames.js
    usernode-loading.js
  tests/                 Vendored determinism / multi-server tests.
  Dockerfile             Multi-stage: rust+wasm-pack → node:22-alpine.
  .env.example
  CLAUDE.md              App-specific notes for AI tooling.
```

## How it works

```
user → sendTransaction(canvasAddr, 1, {app:"falling-sands",type:"draw",points:[…]})
                  │
                  ▼
       [Usernode Blockchain]
                  │
       recipient poller (or direct-node SSE) picks it up
                  │
                  ▼
       engine.processChainTransaction(tx)
                  │
       apply draw to simulation at corresponding tick
                  │
                  ▼
       ┌──────────┴──────────┐
       │                     │
   on-disk snapshot.json   WebSocket fan-out
       │                     │
   fs.watch + 5s debounce    every connected browser
       │                     gets the new tx
       ▼
   sands_state.snapshot
   (Postgres BYTEA)
       │
       └─→ on next cold boot, hydrated back to snapshot.json
           before the engine reads from disk
```

The on-chain transaction stream is the single source of truth. Both the
server and every connected browser run the same WASM build; they diverge
only briefly during a tx propagation window before re-converging on the
canonical state. Snapshots are an optimization to avoid replaying the
entire chain history on cold boot.

## Memo schema

```js
// user → canvas (draw)
{ app: "falling-sands", type: "draw", points: [{ x: 12, y: 34, species: "sand" }, …] }

// admin → canvas (reset)
{ app: "falling-sands", type: "reset" }
// honored only when sender pubkey === ADMIN_PUBKEY
```

## Configuration

| Var | Purpose |
| --- | --- |
| `APP_PUBKEY` | Canvas address. Reuse the canonical falling-sands pubkey so this deploy and the canonical examples deploy converge on identical simulation state. |
| `ADMIN_PUBKEY` | Optional. Sender pubkey permitted to issue reset memos. |
| `NODE_RPC_URL` | Sidecar URL. Default `http://usernode-node:3000` (compose internal). |
| `USE_NODE_STREAM` | `1` to use the sidecar's direct-node SSE for live tail (sub-second instead of 5–60s explorer lag). Default `1`. |
| `SNAPSHOT_DIR` | On-disk snapshot directory. Default `/app/data` inside the container. |
| `DATABASE_URL` | Auto-injected by Social Vibecoding. Used by `lib/snapshot-store.js` to mirror the on-disk snapshot. Unset → disk-only fallback. |
| `PORT` | HTTP port (default 3000). |

## Persistence

Cold boots without a snapshot replay the entire chain history from
genesis (minutes of compute on first paint). To avoid this, the server
mirrors the engine's on-disk `snapshot.json` to a single Postgres BYTEA
row in the per-app database SV provisions automatically — see
`lib/snapshot-store.js` and the **Persistence** section in `CLAUDE.md`.

## Origin

Forked from [`usernode-dapp-starter/examples/falling-sands`](https://github.com/Usernode-Labs/usernode-dapp-starter)
and adapted into a standalone repo so it can be deployed as an
independently-versioned child app on social-vibecoding.
