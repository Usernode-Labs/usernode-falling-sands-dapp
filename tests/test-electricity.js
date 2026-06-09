#!/usr/bin/env node
/**
 * test-electricity.js
 *
 * Exercises the Electricity & Automation system (Wire / Spark / Battery /
 * Switch) directly against the WASM build. Requires the WASM package to be
 * built first:
 *
 *   cd sandspiel && wasm-pack build crate --target nodejs && cd ..
 *   node tests/test-electricity.js
 *
 * Covers, per the Electricity & Automation spec:
 *   1. Propagation     — a spark travels along wire exactly one cell per tick.
 *   2. Switch gating    — current stops at an open switch, flows once closed.
 *   3. Scan symmetry    — propagation is left/right symmetric, proving the
 *                         alternating scan direction does not bias results.
 *   4. Twin determinism — two identically-built universes (wire + battery)
 *                         produce byte-identical buffers after N ticks.
 */

const crypto = require("crypto");
const path = require("path");

const { seedUniverse, WIDTH, HEIGHT, FRAME_SIZE, FLAG_SOURCES } = require(
  path.join(__dirname, "..", "seed-content")
);
const { Universe, Species, memory } = require(path.join(__dirname, "..", "wasm-loader"));

const WIRE = Species.Wire;     // 27
const SPARK = Species.Spark;   // 28
const BATTERY = Species.Battery; // 29
const SWITCH = Species.Switch;   // 30

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL  ${msg}`);
  }
}

// Fresh universe with neutral winds + FLAG_SOURCES set and an empty canvas.
// seedUniverse neutralises the wind field and sets flags; reset() then clears
// the demo content it paints, leaving a blank, flagged canvas.
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

function hashBuffer(u) {
  const cells = new Uint8Array(memory.buffer, u.cells(), FRAME_SIZE);
  return crypto.createHash("sha256").update(Buffer.from(cells)).digest("hex");
}

// ── Test 1: one-cell-per-tick propagation ───────────────────────────────────
function testPropagation() {
  console.log("\n── Propagation (one cell / tick) ──");
  const Y = 200, X0 = 100, L = 24;
  const u = blankUniverse();
  // Spark at the left end, then a straight wire to the right of it.
  paintCell(u, X0, Y, SPARK);
  for (let x = X0 + 1; x <= X0 + L; x++) paintCell(u, x, Y, WIRE);

  // After T ticks the single travelling head should sit exactly at X0 + T.
  let ok = true;
  for (let T = 1; T <= L; T++) {
    u.tick();
    const head = cellAt(u, X0 + T, Y);
    if (head.species !== SPARK) { ok = false; console.log(`    head missing at x=${X0 + T} after ${T} ticks (got species ${head.species})`); break; }
    // No spark should linger one cell behind (clean travelling pulse).
    if (cellAt(u, X0 + T - 1, Y).species === SPARK) { ok = false; console.log(`    stale spark behind head at tick ${T}`); break; }
  }
  check(ok, "spark advances exactly one wire cell per tick");

  // One more tick past the end consumes the pulse (no wire neighbour to light).
  u.tick();
  let anySpark = false;
  for (let x = X0; x <= X0 + L; x++) if (cellAt(u, x, Y).species === SPARK) anySpark = true;
  check(!anySpark, "pulse is consumed at the wire's end (no perpetual spark)");

  // The wire it travelled over is intact and decays back to resting (rb==0).
  for (let t = 0; t < 5; t++) u.tick();
  let allResting = true;
  for (let x = X0; x <= X0 + L; x++) {
    const c = cellAt(u, x, Y);
    if (c.species !== WIRE || c.rb !== 0) { allResting = false; break; }
  }
  check(allResting, "wire returns to resting (rb==0) after the pulse passes");
}

// ── Test 2: switch gating ────────────────────────────────────────────────────
function buildSwitchLine(closed) {
  const Y = 200, X0 = 100, XS = 112, X1 = 124;
  const u = blankUniverse();
  paintCell(u, X0, Y, SPARK);
  for (let x = X0 + 1; x < XS; x++) paintCell(u, x, Y, WIRE);
  paintCell(u, XS, Y, closed ? WIRE : SWITCH); // closed switch == wire
  for (let x = XS + 1; x <= X1; x++) paintCell(u, x, Y, WIRE);
  return { u, Y, X0, XS, X1 };
}

function testSwitchGating() {
  console.log("\n── Switch gating ──");

  // Open switch: current must never reach the right segment.
  {
    const { u, Y, XS, X1 } = buildSwitchLine(false);
    let crossed = false;
    for (let t = 0; t < (X1 - 100 + 8); t++) {
      u.tick();
      for (let x = XS + 1; x <= X1; x++) if (cellAt(u, x, Y).species === SPARK) crossed = true;
      // The switch cell itself must remain an (untouched) Switch.
      if (cellAt(u, XS, Y).species !== SWITCH) crossed = true;
    }
    check(!crossed, "open switch blocks current (right segment never sparks)");
  }

  // Closed switch (drawn as Wire): current reaches the right segment.
  {
    const { u, Y, XS, X1 } = buildSwitchLine(true);
    let reached = false;
    for (let t = 0; t < (X1 - 100 + 8); t++) {
      u.tick();
      for (let x = XS + 1; x <= X1; x++) if (cellAt(u, x, Y).species === SPARK) reached = true;
    }
    check(reached, "closed switch (wire) conducts current to the right segment");
  }
}

// ── Test 3: scan-direction symmetry ─────────────────────────────────────────
function testScanSymmetry() {
  console.log("\n── Scan-direction symmetry ──");
  const Y = 200, CX = 150, L = 20;
  const u = blankUniverse();
  paintCell(u, CX, Y, SPARK);
  for (let k = 1; k <= L; k++) {
    paintCell(u, CX - k, Y, WIRE);
    paintCell(u, CX + k, Y, WIRE);
  }

  // After each tick the species+rb pattern must be mirror-symmetric about CX.
  // (ra differs left vs right because paint draws it from the PRNG, so we
  // compare only species and the refractory countdown.)
  let symmetric = true;
  for (let T = 1; T <= L - 1; T++) {
    u.tick();
    for (let k = 1; k <= T + 1 && k <= L; k++) {
      const l = cellAt(u, CX - k, Y);
      const r = cellAt(u, CX + k, Y);
      if (l.species !== r.species || l.rb !== r.rb) {
        symmetric = false;
        console.log(`    asymmetry at tick ${T}, k=${k}: L(sp=${l.species},rb=${l.rb}) R(sp=${r.species},rb=${r.rb})`);
        break;
      }
    }
    if (!symmetric) break;
  }
  check(symmetric, "propagation is left/right symmetric (scan direction unbiased)");
}

// ── Test 4: twin determinism (wire + battery) ───────────────────────────────
function buildBatteryScene() {
  const Y = 220, X0 = 90, L = 30;
  const u = blankUniverse();
  paintCell(u, X0, Y, BATTERY);
  for (let x = X0 + 1; x <= X0 + L; x++) paintCell(u, x, Y, WIRE);
  // A vertical branch + a switch break, to exercise more paths.
  for (let dy = 1; dy <= 12; dy++) paintCell(u, X0 + 15, Y + dy, WIRE);
  paintCell(u, X0 + 15, Y + 6, SWITCH);
  return u;
}

function testTwinDeterminism() {
  console.log("\n── Twin determinism (battery + wire + switch) ──");
  const N = 300;
  const a = buildBatteryScene();
  const b = buildBatteryScene();
  for (let t = 0; t < N; t++) { a.tick(); b.tick(); }
  const ha = hashBuffer(a);
  const hb = hashBuffer(b);
  check(ha === hb, `two identical universes match after ${N} ticks (${ha.slice(0, 16)}…)`);

  // Sanity: the battery actually injected current (the scene is not inert).
  const c = buildBatteryScene();
  let everSparked = false;
  for (let t = 0; t < 30; t++) {
    c.tick();
    const cells = new Uint8Array(memory.buffer, c.cells(), FRAME_SIZE);
    for (let i = 0; i < cells.length; i += 4) if (cells[i] === SPARK) { everSparked = true; break; }
    if (everSparked) break;
  }
  check(everSparked, "battery emits current into adjacent wire");
}

function main() {
  console.log("Electricity & Automation tests");
  console.log(`  enum: Wire=${WIRE} Spark=${SPARK} Battery=${BATTERY} Switch=${SWITCH}`);
  check(FLAG_SOURCES === 2, "FLAG_SOURCES bit is 2 (battery gating)");

  testPropagation();
  testSwitchGating();
  testScanSymmetry();
  testTwinDeterminism();

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
