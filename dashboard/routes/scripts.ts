/**
 * Dashboard API Routes — Script execution endpoints.
 *
 * POST /api/scripts/sleep           — Trigger sleep cycle
 * POST /api/scripts/persona-import  — Trigger persona bootstrap
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { ScriptRunSchema } from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerScriptRoutes(router: Router): void {
  // SLEEP CYCLE
  router.post("/api/scripts/sleep", async (req, res) => {
    const body = await parseBody(req);
    const data = ScriptRunSchema.parse(body || {});

    try {
      const { runSleepCycle } = await import("../../scripts/sleep_cycle.js");
      // Run async — don't block the response
      const statsPromise = runSleepCycle({ agentId: data.agentId });

      // Return immediately, but also await and log
      sendJson(res, 202, {
        ok: true,
        data: { status: "started", agentId: data.agentId },
      });

      statsPromise.then((stats) => {
        console.log(`[Dashboard] Sleep cycle completed:`, stats);
      }).catch((err) => {
        console.error(`[Dashboard] Sleep cycle failed:`, err);
      });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Script failed");
    }
  });

  // PERSONA IMPORT
  router.post("/api/scripts/persona-import", async (req, res) => {
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    const data = ScriptRunSchema.parse(body);
    if (!data.file) return sendError(res, 400, "Missing 'file' path");

    try {
      const { bootstrapPersona } = await import("../../scripts/bootstrap_persona.js");

      sendJson(res, 202, {
        ok: true,
        data: { status: "started", file: data.file, agentId: data.agentId },
      });

      bootstrapPersona(data.file, { agentId: data.agentId })
        .then(() => console.log(`[Dashboard] Persona import completed: ${data.file}`))
        .catch((err) => console.error(`[Dashboard] Persona import failed:`, err));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Script failed");
    }
  });
}
