#!/usr/bin/env node
/**
 * test-steam.js
 *
 * Exercises the Steam material directly against the WASM build. Requires the
 * WASM package to be built first:
 *
 *   cd wasm && wasm-pack build crate --target nodejs && cd ..
 *   mkdir -p sandspiel/crate && cp -r wasm/crate/pkg sandspiel/crate/pkg
 *   node tests/test-steam.js
 *
 * Covers, per the "Add a new material: Steam" spec:
 *   1. Boiling        — water adjacent to Lava flashes to Steam.
 *   2. Condensation   — a rising steam cell cools back into Water (so a puff
 *                       near the ceiling eventually rains rather than piling up).
 *   3. Twin determinism — two identically-built universes running the new
 *                       boiling + steam path produce byte-identical buffers
 *                       after N ticks. This is the client/server bit-identical
 *                       invariant the engine relies on; it would break if any
 *                       randomness used Math.random instead of the engine PRNG.
 */

const crypto = require("crypto");
const path = require("path");

const { seedUniverse, WIDTH, HEIGHT, FRAME_SIZE } = require(
  path.join(__dirname, "..", "seed-content")
);
const { Universe, Species, memory } = require(path.join(__dirname, "..", "wasm-loader"));

const STEAM = Species.Steam; // 32
const WATER = Species.Water; // 3
const LAVA = Species.Lava;   // 8

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL  ${msg}`);
  }
}

// Fresh, blank, flagged canvas (sources enabled so heat sources work; reset()
// clears the demo content seedUniverse paints and neutralises the wind field).
function blankUniverse() {
  const u = Universe.new(WIDTH, HEIGHT);
  seedUniverse(u, Species, memory, { openBottom: false, sources: true, plantAbsorbs: false });
  u.reset();
  return u;
}

// species/ra/rb/clock are 4 consecutive bytes at (x*HEIGHT + y) * 4.
function cellAt(u, x, y) {
  const cells = new Uint8Array(memory.buffer, u.cells(), FRAME_SIZE);
  const i = (x * HEIGHT + y) * 4;
  return { species: cells[i], ra: cells[i + 1], rb: cells[i + 2], clock: cells[i + 3] };
}

function paintCell(u, x, y, species) {
  u.paint(x, y, 1, species);
}

function countSpecies(u, species) {
  const cells = new Uint8Array(memory.buffer, u.cells(), FRAME_SIZE);
  let n = 0;
  for (let i = 0; i < cells.length; i += 4) if (cells[i] === species) n++;
  return n;
}

function hashBuffer(u) {
  const cells = new Uint8Array(memory.buffer, u.cells(), FRAME_SIZE);
  return crypto.createHash("sha256").update(Buffer.from(cells)).digest("hex");
}

// ── Test 1: boiling (water + lava → steam) ──────────────────────────────────
function testBoiling() {
  console.log("\n── Boiling (water meets heat) ──");
  const u = blankUniverse();
  // A wide pool of water sitting directly on a bed of lava. Each water cell
  // adjacent to lava boils with probability 1-in-4 per tick, so across a wide
  // band over many ticks steam is overwhelmingly certain to appear.
  const Y_WATER = 200, Y_LAVA = 201, X0 = 100, X1 = 160;
  for (let x = X0; x <= X1; x++) {
    paintCell(u, x, Y_LAVA, LAVA);
    paintCell(u, x, Y_WATER, WATER);
  }

  let everSteamed = false;
  for (let t = 0; t < 80; t++) {
    u.tick();
    if (countSpecies(u, STEAM) > 0) { everSteamed = true; break; }
  }
  check(everSteamed, "water adjacent to lava boils into steam");
}

// ── Test 2: condensation (steam cools back into water) ──────────────────────
function testCondensation() {
  console.log("\n── Condensation (steam rains back) ──");
  const u = blankUniverse();
  // A lone steam puff low in an empty column. It rises to the ceiling, then —
  // whether by its ra life countdown running out or by the trapped counter
  // tripping against the top wall — it must condense back into water and stop
  // being steam. It must NOT simply vanish or persist forever.
  paintCell(u, 150, HEIGHT - 20, STEAM);
  check(countSpecies(u, STEAM) === 1, "single steam cell painted");

  let condensed = false;
  for (let t = 0; t < 600; t++) {
    u.tick();
    if (countSpecies(u, STEAM) === 0) { condensed = true; break; }
  }
  check(condensed, "steam stops being steam (condenses) within 600 ticks");
  check(countSpecies(u, WATER) >= 1, "the condensed steam became water (rained back), not nothing");
}

// ── Test 3: twin determinism (boiling + steam path) ─────────────────────────
function buildSteamScene() {
  const u = blankUniverse();
  // Lava bed + water pool (boiling), plus a free steam puff (rise + condense).
  const Y_WATER = 220, Y_LAVA = 221, X0 = 90, X1 = 150;
  for (let x = X0; x <= X1; x++) {
    paintCell(u, x, Y_LAVA, LAVA);
    paintCell(u, x, Y_WATER, WATER);
  }
  for (let k = 0; k < 12; k++) paintCell(u, 200 + k, 120, STEAM);
  return u;
}

function testTwinDeterminism() {
  console.log("\n── Twin determinism (boiling + steam) ──");
  const N = 300;
  const a = buildSteamScene();
  const b = buildSteamScene();
  for (let t = 0; t < N; t++) { a.tick(); b.tick(); }
  const ha = hashBuffer(a);
  const hb = hashBuffer(b);
  check(ha === hb, `two identical universes match after ${N} ticks (${ha.slice(0, 16)}…)`);

  // Sanity: the scene is not inert — boiling actually injected steam at some
  // point during the run (otherwise the determinism check is vacuous).
  const c = buildSteamScene();
  let everSteamed = false;
  for (let t = 0; t < 80; t++) {
    c.tick();
    if (countSpecies(c, STEAM) > 0) { everSteamed = true; break; }
  }
  check(everSteamed, "scene actively produces/holds steam (determinism check is non-vacuous)");
}

function main() {
  console.log("Steam material tests");
  console.log(`  enum: Steam=${STEAM} Water=${WATER} Lava=${LAVA}`);
  check(STEAM === 32, "Steam enum discriminant is 32");

  testBoiling();
  testCondensation();
  testTwinDeterminism();

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
