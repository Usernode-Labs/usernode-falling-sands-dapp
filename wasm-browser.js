/**
 * wasm-browser.js
 *
 * Browser-compatible loader for the sandtable WASM module.
 * Mirrors wasm-loader.js (Node) but uses fetch() + WebAssembly.instantiate().
 * Uses the same seeded PRNG (mulberry32) for deterministic simulation.
 *
 * Usage:
 *   const { Universe, Species, memory } = await loadWasm("/sandtable_bg.wasm");
 */

// ── Seeded PRNG (mulberry32) — must match wasm-loader.js exactly ────────────
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

// ── Universe wrapper ────────────────────────────────────────────────────────
class Universe {
  constructor(ptr, wasm) {
    this._ptr = ptr;
    this._wasm = wasm;
  }

  static new(width, height, wasm) {
    return new Universe(wasm.universe_new(width, height), wasm);
  }

  tick() { this._wasm.universe_tick(this._ptr); }
  reset() { this._wasm.universe_reset(this._ptr); }
  width() { return this._wasm.universe_width(this._ptr); }
  height() { return this._wasm.universe_height(this._ptr); }
  cells() { return this._wasm.universe_cells(this._ptr) >>> 0; }
  winds() { return this._wasm.universe_winds(this._ptr) >>> 0; }
  burns() { return this._wasm.universe_burns(this._ptr) >>> 0; }
  paint(x, y, size, species) { this._wasm.universe_paint(this._ptr, x, y, size, species); }
  set_flags(flags) { this._wasm.universe_set_flags(this._ptr, flags); }
  generation() { return this._wasm.universe_generation(this._ptr); }
  set_generation(gen) { this._wasm.universe_set_generation(this._ptr, gen); }
  rng_state() { return this._wasm.universe_rng_state(this._ptr); }
  set_rng_state(state) { this._wasm.universe_set_rng_state(this._ptr, state); }
}

// ── Load & instantiate ──────────────────────────────────────────────────────

async function loadWasm(wasmUrl) {
  let wasm;

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

  const resp = await fetch(wasmUrl);
  if (!resp.ok) throw new Error(`Failed to fetch WASM: ${resp.status}`);

  let instance;
  if (typeof WebAssembly.instantiateStreaming === "function") {
    const result = await WebAssembly.instantiateStreaming(resp, imports);
    instance = result.instance;
  } else {
    const bytes = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, imports);
    instance = result.instance;
  }

  wasm = instance.exports;
  wasm.__wbindgen_start();

  return {
    Universe: {
      new(width, height) { return Universe.new(width, height, wasm); },
    },
    Species,
    memory: wasm.memory,
    prng: seededRandom,
  };
}

// Expose globally for use in index.html <script> tags
window.loadSandspielWasm = loadWasm;
window.SandspielSpecies = Species;
