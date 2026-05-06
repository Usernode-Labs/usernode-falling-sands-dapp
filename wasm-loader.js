/**
 * wasm-loader.js
 *
 * Loads the sandtable WASM module (built with wasm-pack --target nodejs)
 * and re-exports Universe, Species, and the raw WASM memory so the server
 * can read cell buffers directly.
 *
 * Uses a seeded PRNG (mulberry32) instead of Math.random() so that the
 * simulation is fully deterministic given the same seed and input sequence.
 */

const fs = require("fs");
const path = require("path");

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
// Deterministic replacement for Math.random(). The same seed produces the same
// sequence on every run, on every platform. Shared with wasm-browser.js.
const PRNG_SEED = 0xDEAD_BEEF;

function createSeededRandom(seed) {
  let s = seed >>> 0;
  function mulberry32() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  mulberry32.getState = () => s;
  mulberry32.setState = (v) => { s = v >>> 0; };
  return mulberry32;
}

const seededRandom = createSeededRandom(PRNG_SEED);

// ── Load & instantiate the WASM module ──────────────────────────────────────

const wasmPath = path.join(
  __dirname,
  "sandspiel",
  "crate",
  "pkg",
  "sandtable_bg.wasm"
);
const wasmBytes = fs.readFileSync(wasmPath);

let wasm; // assigned after instantiation, used by imports too

const cachedTextDecoder = new TextDecoder("utf-8", {
  ignoreBOM: true,
  fatal: true,
});
cachedTextDecoder.decode();

function getUint8ArrayMemory() {
  return new Uint8Array(wasm.memory.buffer);
}

function getStringFromWasm(ptr, len) {
  return cachedTextDecoder.decode(
    getUint8ArrayMemory().subarray(ptr >>> 0, (ptr >>> 0) + len)
  );
}

// Imports expected by the wasm-bindgen glue.
// Hash suffixes change on every wasm-pack rebuild, so we use a Proxy to match
// by prefix instead of exact name — no manual updates needed after recompiles.
const knownImports = {
  __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
  },
};

const importProxy = new Proxy(knownImports, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === "string") {
      if (prop.startsWith("__wbg_random_"))
        return seededRandom;
      if (prop.startsWith("__wbg___wbindgen_throw_"))
        return (arg0, arg1) => {
          throw new Error(getStringFromWasm(arg0, arg1));
        };
    }
    return undefined;
  },
  has(target, prop) {
    if (prop in target) return true;
    if (typeof prop === "string") {
      return (
        prop.startsWith("__wbg_random_") ||
        prop.startsWith("__wbg___wbindgen_throw_")
      );
    }
    return false;
  },
});

const imports = { "./sandtable_bg.js": importProxy };

const wasmModule = new WebAssembly.Module(wasmBytes);
wasm = new WebAssembly.Instance(wasmModule, imports).exports;
wasm.__wbindgen_start();

// ── Species enum (mirrors the Rust #[wasm_bindgen] enum) ────────────────────

const Species = Object.freeze({
  Empty: 0,
  Wall: 1,
  Sand: 2,
  Water: 3,
  Gas: 4,
  Cloner: 5,
  Fire: 6,
  Wood: 7,
  Lava: 8,
  Ice: 9,
  Plant: 11,
  Acid: 12,
  Stone: 13,
  Dust: 14,
  Mite: 15,
  Oil: 16,
  Rocket: 17,
  Fungus: 18,
  Seed: 19,
  Spout: 20,
  SandSource: 21,
  Torch: 22,
  OilWell: 23,
});

// ── Thin wrapper around the raw WASM exports ────────────────────────────────

class Universe {
  constructor(ptr) {
    this._ptr = ptr;
  }

  static new(width, height) {
    return new Universe(wasm.universe_new(width, height));
  }

  tick() {
    wasm.universe_tick(this._ptr);
  }
  tick_n(count) {
    if (wasm.universe_tick_n) {
      wasm.universe_tick_n(this._ptr, count);
    } else {
      for (let i = 0; i < count; i++) wasm.universe_tick(this._ptr);
    }
  }
  reset() {
    wasm.universe_reset(this._ptr);
  }
  width() {
    return wasm.universe_width(this._ptr);
  }
  height() {
    return wasm.universe_height(this._ptr);
  }
  cells() {
    return wasm.universe_cells(this._ptr) >>> 0;
  }
  winds() {
    return wasm.universe_winds(this._ptr) >>> 0;
  }
  burns() {
    return wasm.universe_burns(this._ptr) >>> 0;
  }
  paint(x, y, size, species) {
    wasm.universe_paint(this._ptr, x, y, size, species);
  }
  set_flags(flags) {
    wasm.universe_set_flags(this._ptr, flags);
  }
  generation() {
    return wasm.universe_generation(this._ptr);
  }
  set_generation(gen) {
    wasm.universe_set_generation(this._ptr, gen);
  }
  rng_state() {
    return wasm.universe_rng_state(this._ptr);
  }
  set_rng_state(state) {
    wasm.universe_set_rng_state(this._ptr, state);
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  Universe,
  Species,
  /** Raw WebAssembly.Memory – use .buffer to build typed array views. */
  memory: wasm.memory,
  /** PRNG handle — call .getState()/.setState(n) to save/restore for checkpoints. */
  prng: seededRandom,
};
