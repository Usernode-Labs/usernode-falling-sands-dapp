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
  GasSource: 24,
  AcidSource: 25,
  BlackHole: 26,
  Wire: 27,
  Spark: 28,
  Battery: 29,
  Switch: 30,
  Steam: 32,
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

async function loadWasm(wasmUrl, opts) {
  const timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : 20000;
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

  // Time-box the whole fetch + instantiation. Without this, a stalled
  // CDN/proxy / half-open connection on flaky mobile networks leaves the
  // `await` pending forever — it neither resolves nor rejects — and the
  // caller's loader gate hangs with no error. An AbortController fires
  // after `timeoutMs`; because instantiateStreaming consumes the Response
  // body stream, aborting the underlying fetch rejects a stalled streaming
  // instantiation too, and the same signal covers the arrayBuffer() read.
  const controller = (typeof AbortController === "function") ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(function () {
    timedOut = true;
    if (controller) controller.abort();
  }, timeoutMs);

  // Sniff the leading bytes of a buffer as text so a hard failure can report
  // *what* arrived instead of a wasm module — e.g. an HTML login/redirect page
  // (auth/proxy interception) or a plain-text error, vs. a genuine wasm binary
  // (magic word "\0asm" → bytes 00 61 73 6d). Kept short and best-effort.
  function sniffBytes(buf) {
    try {
      const view = new Uint8Array(buf).subarray(0, 64);
      let s = "";
      for (let i = 0; i < view.length; i++) {
        const b = view[i];
        s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".";
      }
      return s;
    } catch (_) {
      return "";
    }
  }

  // Buffered instantiation: read the whole body, then compile. Works
  // regardless of Content-Type (unlike instantiateStreaming, which rejects
  // anything not labelled application/wasm) and gives us the bytes to sniff
  // for a precise error. `respForBuffer` must be an unconsumed Response.
  async function instantiateBuffered(respForBuffer) {
    const bytes = await respForBuffer.arrayBuffer();
    // A valid wasm binary starts with the magic word 00 61 73 6d. If it
    // doesn't, instantiate() would throw an opaque CompileError — surface the
    // real cause (status/type/first bytes) instead.
    const head = new Uint8Array(bytes);
    const looksLikeWasm =
      head.length >= 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    if (!looksLikeWasm) {
      throw new Error(
        "WASM response was not a WebAssembly module (got " + bytes.byteLength +
        " bytes starting \"" + sniffBytes(bytes) + "\")"
      );
    }
    const result = await WebAssembly.instantiate(bytes, imports);
    return result.instance;
  }

  let instance;
  try {
    const fetchOpts = controller ? { signal: controller.signal } : undefined;
    const resp = await fetch(wasmUrl, fetchOpts);
    if (!resp.ok) {
      const ct = (resp.headers && resp.headers.get) ? (resp.headers.get("content-type") || "?") : "?";
      throw new Error("Failed to fetch WASM: HTTP " + resp.status + " (content-type: " + ct + ")");
    }

    const contentType = (resp.headers && resp.headers.get) ? (resp.headers.get("content-type") || "") : "";
    const isWasmType = /(^|[ ;])application\/wasm($|[ ;])/i.test(contentType);
    const canStream = typeof WebAssembly.instantiateStreaming === "function";

    if (canStream && isWasmType) {
      // Fast path. Clone first so a streaming rejection (locked/decoded body,
      // truncated stream behind a buffering proxy) can still fall back to a
      // buffered read of the untouched clone instead of failing outright.
      const clone = (typeof resp.clone === "function") ? resp.clone() : null;
      try {
        const result = await WebAssembly.instantiateStreaming(resp, imports);
        instance = result.instance;
      } catch (streamErr) {
        if (!clone) throw streamErr;
        instance = await instantiateBuffered(clone);
      }
    } else {
      // Either streaming is unavailable, or the response isn't labelled
      // application/wasm (the common staging-ingress case) — skip the
      // guaranteed-to-throw streaming attempt and go straight to buffered.
      instance = await instantiateBuffered(resp);
    }
  } catch (err) {
    // Guarantee a non-empty, specific message so the loader-error card always
    // renders a "Detail:" line a reporter can copy.
    if (timedOut) {
      throw new Error("WASM load timed out after " + Math.round(timeoutMs / 1000) + "s");
    }
    const msg = (err && err.message) ? err.message : String(err || "unknown error");
    throw new Error(msg || "WASM load failed (no error message)");
  } finally {
    clearTimeout(timer);
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
