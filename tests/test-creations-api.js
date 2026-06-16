#!/usr/bin/env node
/**
 * test-creations-api.js
 *
 * Integration test of the saved-creations HTTP surface
 * (lib/creations-routes.js) wired against an in-memory store — no engine,
 * no Postgres. Boots a real Express server on an ephemeral port and drives
 * it over HTTP:
 *
 *   POST /__sands/creations         → 201 { id }
 *   GET  /__sands/creations?owner=  → list (no snapshot blob)
 *   GET  /__sands/creations/:id     → full creation (public, no wallet)
 *   PATCH/DELETE owner-gating       → 404 on mismatch, ok on owner
 *   POST without owner              → 401
 *   GET  /__sands/creations/:id 404 → unknown id
 *
 * Usage: node tests/test-creations-api.js
 */

const assert = require("assert");
const http = require("http");
const express = require("express");
const zlib = require("zlib");
const { createCreationsStore } = require("../lib/creations-store");
const { mountCreationsRoutes } = require("../lib/creations-routes");

let passed = 0;
function ok(label) { console.log(`  ✓ ${label}`); passed++; }

function bundle() {
  const raw = Buffer.alloc(48, 5);
  return {
    cells_b64: zlib.deflateSync(raw, { level: 1 }).toString("base64"),
    buffers: 3, prng_state: 1, generation: 0, wasm_rng_state: "0",
    tick: 10, width: 300, height: 450,
  };
}

async function req(base, method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + path, opts);
  let json = null;
  try { json = await resp.json(); } catch (_) {}
  return { status: resp.status, json };
}

async function main() {
  const ALICE = "ut1_alice";
  const BOB = "ut1_bob";

  const store = createCreationsStore({ databaseUrl: null });
  await store.init();

  const app = express();
  mountCreationsRoutes(app, { express, getStore: () => store });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    // POST — create
    let r = await req(base, "POST", "/__sands/creations", { owner: ALICE, title: "Mine", snapshot: bundle() });
    assert.strictEqual(r.status, 201, "POST → 201");
    assert.ok(r.json && r.json.id, "POST returns id");
    const id = r.json.id;
    ok("POST creates a creation (201 + id)");

    // GET list — no blob
    r = await req(base, "GET", "/__sands/creations?owner=" + ALICE);
    assert.strictEqual(r.status, 200, "list → 200");
    assert.strictEqual(r.json.items.length, 1, "one item");
    assert.ok(!("snapshot" in r.json.items[0]), "list omits snapshot blob");
    ok("GET list returns metadata only");

    // GET by id — full, public (no owner/wallet needed)
    r = await req(base, "GET", "/__sands/creations/" + id);
    assert.strictEqual(r.status, 200, "get by id → 200");
    assert.ok(r.json.snapshot && r.json.snapshot.cells_b64, "full bundle present");
    assert.strictEqual(r.json.snapshot.tick, 10, "snapshot round-trips over HTTP");
    ok("GET by id is public and returns the full snapshot (share path)");

    // POST without owner → 401
    r = await req(base, "POST", "/__sands/creations", { title: "x", snapshot: bundle() });
    assert.strictEqual(r.status, 401, "no owner → 401");
    ok("POST without owner is rejected (401)");

    // PATCH owner-gating
    r = await req(base, "PATCH", "/__sands/creations/" + id, { owner: BOB, title: "hax" });
    assert.strictEqual(r.status, 404, "rename by non-owner → 404");
    r = await req(base, "PATCH", "/__sands/creations/" + id, { owner: ALICE, title: "Renamed" });
    assert.strictEqual(r.status, 200, "rename by owner → 200");
    r = await req(base, "GET", "/__sands/creations/" + id);
    assert.strictEqual(r.json.title, "Renamed", "rename applied");
    ok("PATCH rename is owner-gated");

    // DELETE owner-gating
    r = await req(base, "DELETE", "/__sands/creations/" + id + "?owner=" + BOB);
    assert.strictEqual(r.status, 404, "delete by non-owner → 404");
    r = await req(base, "DELETE", "/__sands/creations/" + id + "?owner=" + ALICE);
    assert.strictEqual(r.status, 200, "delete by owner → 200");
    r = await req(base, "GET", "/__sands/creations/" + id);
    assert.strictEqual(r.status, 404, "deleted creation → 404");
    ok("DELETE is owner-gated; deleted creation 404s (stale share link)");

    // Unknown id → 404
    r = await req(base, "GET", "/__sands/creations/doesnotexist");
    assert.strictEqual(r.status, 404, "unknown id → 404");
    ok("unknown creation id → 404");

    console.log(`\nAll ${passed} creations-API checks passed.`);
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
