/**
 * Scan Funnel Archive Routes — Phase 1 (forensic archive).
 *
 * Endpoints additifs, montés sous /scan-funnel dans server.js :
 *   POST /scan-funnel/archive               — archive un payload compact
 *   GET  /scan-funnel/sessions/:scanSessionId — session + events
 *   GET  /scan-funnel/sessions?limit=50     — liste des sessions récentes
 *
 * Aucune logique Yahoo/IBKR ici : la route ne fait que persister ce que le
 * dashboard a déjà calculé. Best-effort côté appelant — l'échec n'altère pas le scan.
 */

import { Router } from "express";
import { MAX_EVENTS } from "./scanFunnelArchiveStore.js";

export default function createScanFunnelArchiveRoutes({ store }) {
  const router = Router();
  const maxEvents = Number(store?.maxEvents) || MAX_EVENTS;

  // ── POST /scan-funnel/archive ────────────────────────────────────────────
  router.post("/archive", async (req, res) => {
    try {
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      const scanSessionId = String(payload?.scanSessionId ?? "").trim();
      if (!scanSessionId) {
        return res.status(400).json({ ok: false, error: "scanSessionId required" });
      }

      const events = Array.isArray(payload?.events) ? payload.events : [];
      if (events.length > maxEvents) {
        return res.status(413).json({
          ok: false,
          error: `too many events: ${events.length} > ${maxEvents}`,
        });
      }

      const result = await store.archiveSession(payload);
      if (!result?.ok) {
        return res.status(400).json({ ok: false, error: result?.error || "archive_failed" });
      }
      return res.json({
        ok: true,
        scanSessionId: result.scanSessionId,
        eventsArchived: result.eventsArchived,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? "archive_failed") });
    }
  });

  // ── GET /scan-funnel/sessions?limit=50 ───────────────────────────────────
  router.get("/sessions", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const sessions = await store.listSessions({ limit });
      return res.json({ ok: true, sessions, count: sessions.length });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? "list_failed") });
    }
  });

  // ── GET /scan-funnel/sessions/:scanSessionId ─────────────────────────────
  router.get("/sessions/:scanSessionId", async (req, res) => {
    try {
      const scanSessionId = String(req.params.scanSessionId ?? "").trim();
      if (!scanSessionId) {
        return res.status(400).json({ ok: false, error: "scanSessionId required" });
      }
      const result = await store.getSession(scanSessionId);
      if (!result) {
        return res.status(404).json({ ok: false, error: `no archive for ${scanSessionId}` });
      }
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? "get_failed") });
    }
  });

  return router;
}
