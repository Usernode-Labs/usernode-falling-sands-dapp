/**
 * seed-content.js
 *
 * Shared initial universe setup — paint calls, wind neutralisation, and flags.
 * Used by engine.js (server) and tests to ensure identical starting state.
 */

const WIDTH = 300;
const HEIGHT = 450;
const CELL_BYTES = 4;
const FRAME_SIZE = WIDTH * HEIGHT * CELL_BYTES;

const FLAG_OPEN_BOTTOM = 1;
const FLAG_SOURCES = 2;
const FLAG_PLANT_ABSORBS = 4;

/**
 * Initialise a universe with the canonical starting state.
 *
 * @param {object} universe  — Universe instance (from wasm-loader or wasm-browser)
 * @param {object} Species   — Species enum object
 * @param {WebAssembly.Memory} memory — raw WASM memory
 * @param {object} [opts]
 * @param {boolean} [opts.openBottom=true]
 * @param {boolean} [opts.sources=true]
 * @param {boolean} [opts.plantAbsorbs=true]
 * @returns {{ flags: number, sourcesEnabled: boolean }}
 */
function seedUniverse(universe, Species, memory, opts) {
  const openBottom = opts && opts.openBottom !== undefined ? opts.openBottom : true;
  const sourcesEnabled = opts && opts.sources !== undefined ? opts.sources : true;
  const plantAbsorbs = opts && opts.plantAbsorbs !== undefined ? opts.plantAbsorbs : true;

  let flags = 0;
  if (openBottom) flags |= FLAG_OPEN_BOTTOM;
  if (sourcesEnabled) flags |= FLAG_SOURCES;
  if (plantAbsorbs) flags |= FLAG_PLANT_ABSORBS;
  if (flags) universe.set_flags(flags);

  // Neutralise the wind field
  const windsPtr = universe.winds();
  const winds = new Uint8Array(memory.buffer, windsPtr, FRAME_SIZE);
  for (let i = 0; i < winds.length; i += 4) {
    winds[i]     = 126;
    winds[i + 1] = 126;
    winds[i + 2] = 0;
    winds[i + 3] = 0;
  }

  // Seed initial content
  if (sourcesEnabled) {
    const srcY = Math.round(HEIGHT / 8);
    const gap = WIDTH / 5;
    universe.paint(Math.round(gap * 1), srcY, 5, Species.Spout);
    universe.paint(Math.round(gap * 2), srcY, 5, Species.SandSource);
    universe.paint(Math.round(gap * 3), srcY, 5, Species.Torch);
    universe.paint(Math.round(gap * 4), srcY, 5, Species.OilWell);

    const cupBottom = Math.round(HEIGHT * 7 / 8);
    const cupW = 18;
    const cupH = 14;
    const cupSources = [1, 2, 4];
    for (const si of cupSources) {
      const cx = Math.round(gap * si);
      for (let dy = 0; dy <= cupH; dy++) {
        universe.paint(cx - cupW, cupBottom - dy, 2, Species.Wall);
        universe.paint(cx + cupW, cupBottom - dy, 2, Species.Wall);
      }
      for (let dx = -cupW; dx <= cupW; dx += 2) {
        universe.paint(cx + dx, cupBottom, 2, Species.Wall);
      }
    }
  } else {
    universe.paint(150, 40, 8, Species.Sand);
    universe.paint(100, 40, 6, Species.Sand);
    universe.paint(200, 40, 6, Species.Sand);
    universe.paint(150, 100, 6, Species.Water);
    universe.paint(100, 120, 5, Species.Water);
  }

  return { flags, sourcesEnabled };
}

module.exports = {
  seedUniverse,
  WIDTH,
  HEIGHT,
  CELL_BYTES,
  FRAME_SIZE,
  FLAG_OPEN_BOTTOM,
  FLAG_SOURCES,
  FLAG_PLANT_ABSORBS,
};
