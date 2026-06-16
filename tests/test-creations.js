#!/usr/bin/env node
/**
 * test-creations.js
 *
 * Exercises lib/creations-store.js in its in-memory (DATABASE_URL unset)
 * degradation mode — no Postgres required — plus the pure capture/restore
 * round-trip property and the HTTP-shaped validation rules:
 *
 *   1) create / listByOwner / getById / remove / rename happy path.
 *   2) Owner-mismatch rejection on remove + rename (you can't touch
 *      another wallet's creations).
 *   3) Per-owner cap is enforced (CreationError code 'cap').
 *   4) Validation: missing owner, malformed snapshot, oversized payload.
 *   5) Capture round-trip: a captured bundle survives encodeSnapshot →
 *      decodeSnapshot byte-for-byte (the same shape loadSnapshot reads),
 *      and the demo seed produces a loadable bundle.
 *   6) Thumbnail decode strips a data: URL prefix.
 *
 * Usage: node tests/test-creations.js
 */

const assert = require("assert");
const zlib = require("zlib");
const {
  createCreationsStore,
  CreationError,
  sanitizeTitle,
  decodeThumb,
  encodeSnapshot,
  decodeSnapshot,
  MAX_SNAPSHOT_BYTES,
} = require("../lib/creations-store");

let passed = 0;
function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

// A minimal but well-formed capture bundle (same shape loadSnapshot reads).
function bundle(seed) {
  const raw = Buffer.alloc(64);
  raw.fill(seed & 0xff);
  return {
    cells_b64: zlib.deflateSync(raw, { level: 1 }).toString("base64"),
    buffers: 3,
    prng_state: 12345,
    generation: 7,
    wasm_rng_state: "98765",
    tick: 4242,
    width: 300,
    height: 450,
  };
}

async function main() {
  const ALICE = "ut1_alice";
  const BOB = "ut1_bob";

  // ── 1) Happy path ────────────────────────────────────────────────
  const store = createCreationsStore({ databaseUrl: null, perOwnerCap: 3 });
  await store.init();

  const a1 = await store.create({ owner: ALICE, title: "First", snapshot: bundle(1), thumb_b64: null });
  assert.ok(a1.id, "create returns an id");
  const a2 = await store.create({ owner: ALICE, title: "Second", snapshot: bundle(2), thumb_b64: "data:image/png;base64,iVBOR" });

  let list = await store.listByOwner(ALICE);
  assert.strictEqual(list.length, 2, "alice has 2 creations");
  assert.strictEqual(list[0].id, a2.id, "newest first");
  assert.ok(!("snapshot" in list[0]), "list omits the heavy snapshot blob");
  ok("create / list (newest first, no blob in list)");

  const full = await store.getById(a1.id);
  assert.ok(full && full.snapshot, "getById returns the full bundle");
  assert.strictEqual(full.snapshot.tick, 4242, "snapshot round-trips tick");
  assert.strictEqual(full.snapshot.wasm_rng_state, "98765", "snapshot round-trips rng state");
  ok("getById returns a faithfully round-tripped snapshot");

  // ── 2) Owner-mismatch rejection ──────────────────────────────────
  assert.strictEqual(await store.remove(a1.id, BOB), false, "bob cannot delete alice's creation");
  assert.strictEqual(await store.rename(a1.id, BOB, "hacked"), false, "bob cannot rename alice's creation");
  let stillThere = await store.getById(a1.id);
  assert.ok(stillThere, "creation survived the mismatched delete");
  assert.strictEqual(stillThere.title, "First", "title untouched by mismatched rename");
  ok("owner-mismatch delete + rename are rejected");

  assert.strictEqual(await store.rename(a1.id, ALICE, "Renamed"), true, "owner can rename");
  assert.strictEqual((await store.getById(a1.id)).title, "Renamed", "rename applied");
  assert.strictEqual(await store.remove(a2.id, ALICE), true, "owner can delete");
  assert.strictEqual((await store.listByOwner(ALICE)).length, 1, "1 left after delete");
  ok("owner can rename + delete");

  // ── 3) Per-owner cap ─────────────────────────────────────────────
  await store.create({ owner: ALICE, title: "C2", snapshot: bundle(3) });
  await store.create({ owner: ALICE, title: "C3", snapshot: bundle(4) }); // now at cap=3
  let capErr = null;
  try {
    await store.create({ owner: ALICE, title: "C4", snapshot: bundle(5) });
  } catch (e) { capErr = e; }
  assert.ok(capErr instanceof CreationError && capErr.code === "cap", "cap enforced with code 'cap'");
  ok("per-owner cap rejects beyond the limit");

  // ── 4) Validation ────────────────────────────────────────────────
  await assert.rejects(
    () => store.create({ owner: "", title: "x", snapshot: bundle(1) }),
    (e) => e instanceof CreationError && e.code === "no_owner",
    "missing owner rejected"
  );
  await assert.rejects(
    () => store.create({ owner: BOB, title: "x", snapshot: { nope: true } }),
    (e) => e instanceof CreationError && e.code === "bad_request",
    "malformed snapshot rejected"
  );
  // Oversized: encodeSnapshot caps the GZIPPED bundle, so use incompressible
  // (random) bytes — repeated chars would compress away under the limit.
  const huge = {
    cells_b64: require("crypto").randomBytes(Math.floor(MAX_SNAPSHOT_BYTES * 1.5)).toString("base64"),
    buffers: 3, width: 300, height: 450,
  };
  assert.throws(() => encodeSnapshot(huge), (e) => e.code === "too_large", "oversized snapshot rejected");
  ok("validation: owner / malformed / oversized");

  // ── 5) Capture round-trip + demo seed loadability ────────────────
  const b = bundle(99);
  const restored = decodeSnapshot(encodeSnapshot(b));
  assert.deepStrictEqual(restored, b, "encode→decode is identity");
  ok("snapshot bundle survives encode→decode byte-identically");

  const seeded = createCreationsStore({ databaseUrl: null });
  await seeded.init();
  await seeded.seedDemo();
  const shared = await seeded.getById(seeded.SEED_SHARE_ID);
  assert.ok(shared && shared.snapshot && shared.snapshot.cells_b64, "demo share id is loadable");
  assert.strictEqual(shared.snapshot.buffers, 3, "demo bundle has 3 buffers");
  ok("seedDemo produces a loadable creation at SEED_SHARE_ID");

  // ── 6) Thumbnail decode ──────────────────────────────────────────
  assert.strictEqual(decodeThumb(null), null, "null thumb → null");
  const t = decodeThumb("data:image/png;base64," + Buffer.from("hi").toString("base64"));
  assert.ok(Buffer.isBuffer(t) && t.toString() === "hi", "data: URL prefix stripped + decoded");
  assert.strictEqual(sanitizeTitle("   "), "Untitled creation", "blank title gets a default");
  ok("thumbnail decode + title sanitize");

  console.log(`\nAll ${passed} creations-store checks passed.`);
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
