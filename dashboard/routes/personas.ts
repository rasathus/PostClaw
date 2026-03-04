/**
 * Dashboard API Routes — Persona management endpoints.
 *
 * GET    /api/personas        — List all persona entries
 * POST   /api/personas        — Create persona entry
 * PUT    /api/personas/:id    — Update persona entry
 * DELETE /api/personas/:id    — Delete persona entry
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  deletePersona,
} from "../../services/personaService.js";
import type { PersonaCreate, PersonaUpdate } from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerPersonaRoutes(router: Router): void {
  // LIST
  router.get("/api/personas", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const rows = await listPersonas(agentId);
    sendJson(res, 200, { ok: true, data: rows });
  });

  // GET ONE
  router.get("/api/personas/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const persona = await getPersona(agentId, ctx.params.id);
    if (!persona) return sendError(res, 404, "Persona not found");
    sendJson(res, 200, { ok: true, data: persona });
  });

  // CREATE
  router.post("/api/personas", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody<PersonaCreate>(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");
    try {
      const persona = await createPersona(agentId, body);
      sendJson(res, 201, { ok: true, data: persona });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Create failed");
    }
  });

  // UPDATE
  router.put("/api/personas/:id", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody<PersonaUpdate>(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");
    try {
      const persona = await updatePersona(agentId, ctx.params.id, body);
      if (!persona) return sendError(res, 404, "Persona not found");
      sendJson(res, 200, { ok: true, data: persona });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Update failed");
    }
  });

  // DELETE
  router.delete("/api/personas/:id", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const deleted = await deletePersona(agentId, ctx.params.id);
    if (!deleted) return sendError(res, 404, "Persona not found");
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  });
}
