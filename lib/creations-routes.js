/**
 * lib/creations-routes.js — HTTP surface for the saved-creations gallery.
 *
 * Extracted from server.js so the route contract (status codes, JSON
 * shapes, body parsing, owner-gating) can be exercised by an integration
 * test without booting the WASM engine. server.js and tests both call
 * mountCreationsRoutes() against the same handlers.
 *
 * All routes are public — falling-sands has no JWT gate (see CLAUDE.md
 * "Auth model"); ownership is client-asserted via the `owner` wallet
 * pubkey, the same trust model the leaderboard uses with `me=<pubkey>`.
 */

"use strict";

const { CreationError } = require("./creations-store");

function creationErrStatus(code) {
  switch (code) {
    case "no_owner": return 401;
    case "too_large": return 413;
    case "cap": return 409;
    case "bad_request": return 400;
    default: return 400;
  }
}

/**
 * @param app       Express app (or router)
 * @param express   the express module (for express.json())
 * @param getStore  () => creationsStore | null  (null while still booting)
 */
function mountCreationsRoutes(app, { express, getStore }) {
  // Scoped JSON parser with a raised limit. The rest of the app is
  // read-only and never parses bodies, so this stays local to the write
  // routes rather than installed app-wide.
  const creationsJson = express.json({ limit: "6mb" });

  // POST /__sands/creations — save a new creation. Body:
  //   { owner, title, snapshot:{cells_b64,buffers,...,width,height}, thumb_b64 }
  app.post("/__sands/creations", creationsJson, async (req, res) => {
    const creations = getStore();
    if (!creations) return res.status(503).json({ error: "Gallery loading…" });
    try {
      const out = await creations.create(req.body || {});
      res.set("Cache-Control", "no-store");
      res.status(201).json(out);
    } catch (e) {
      if (e instanceof CreationError) {
        return res.status(creationErrStatus(e.code)).json({ error: e.message, code: e.code });
      }
      console.warn(`[creations] create failed: ${e.message}`);
      res.status(500).json({ error: "Failed to save creation" });
    }
  });

  // GET /__sands/creations?owner=<pubkey> — list one owner's creations
  // (metadata + thumbnail only, newest first).
  app.get("/__sands/creations", async (req, res) => {
    const creations = getStore();
    if (!creations) return res.status(503).json({ error: "Gallery loading…" });
    const owner = typeof req.query.owner === "string" ? req.query.owner : "";
    try {
      const items = await creations.listByOwner(owner);
      res.set("Cache-Control", "no-store");
      res.json({ owner, items });
    } catch (e) {
      console.warn(`[creations] list failed: ${e.message}`);
      res.status(500).json({ error: "Failed to load gallery" });
    }
  });

  // GET /__sands/creations/:id — full creation (incl. snapshot) for
  // view/share. Public so a shared link resolves for any visitor.
  app.get("/__sands/creations/:id", async (req, res) => {
    const creations = getStore();
    if (!creations) return res.status(503).json({ error: "Gallery loading…" });
    try {
      const row = await creations.getById(req.params.id);
      if (!row) return res.status(404).json({ error: "Creation not found" });
      res.set("Cache-Control", "public, max-age=300"); // immutable once created
      res.json(row);
    } catch (e) {
      console.warn(`[creations] get failed: ${e.message}`);
      res.status(500).json({ error: "Failed to load creation" });
    }
  });

  // DELETE /__sands/creations/:id?owner=<pubkey> — owner-gated delete.
  app.delete("/__sands/creations/:id", async (req, res) => {
    const creations = getStore();
    if (!creations) return res.status(503).json({ error: "Gallery loading…" });
    const owner = typeof req.query.owner === "string" ? req.query.owner : "";
    try {
      const ok = await creations.remove(req.params.id, owner);
      if (!ok) return res.status(404).json({ error: "Not found or not yours" });
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (e) {
      console.warn(`[creations] delete failed: ${e.message}`);
      res.status(500).json({ error: "Failed to delete creation" });
    }
  });

  // PATCH /__sands/creations/:id — owner-gated rename. Body: { owner, title }
  app.patch("/__sands/creations/:id", creationsJson, async (req, res) => {
    const creations = getStore();
    if (!creations) return res.status(503).json({ error: "Gallery loading…" });
    const body = req.body || {};
    const owner = typeof body.owner === "string" ? body.owner : "";
    try {
      const ok = await creations.rename(req.params.id, owner, body.title);
      if (!ok) return res.status(404).json({ error: "Not found or not yours" });
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (e) {
      console.warn(`[creations] rename failed: ${e.message}`);
      res.status(500).json({ error: "Failed to rename creation" });
    }
  });
}

module.exports = { mountCreationsRoutes, creationErrStatus };
