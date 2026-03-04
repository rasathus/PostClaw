import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getCurrentConfig, saveConfig, PostClawConfig } from "../../services/config.js";

export function registerConfigRoutes(router: Router) {
  // GET /api/config — Get current PostClaw configuration
  router.get("/api/config", async (_req, res) => {
    try {
      const config = getCurrentConfig();
      sendJson(res, 200, { ok: true, data: config });
    } catch (err) {
      sendError(res, 500, `Failed to get config: ${err}`);
    }
  });

  // POST /api/config — Update PostClaw configuration
  router.post("/api/config", async (req, res) => {
    try {
      const body = await parseBody<PostClawConfig>(req);
      if (!body) return sendError(res, 400, "Missing request body");

      // In a real app we'd validate with Zod, but for now we'll trust the UI
      // because we're merging with defaults anyway.
      await saveConfig(body);
      sendJson(res, 200, { ok: true, data: getCurrentConfig() });
    } catch (err) {
      sendError(res, 500, `Failed to save config: ${err}`);
    }
  });

  // POST /api/config/reset — Reset to defaults
  router.post("/api/config/reset", async (_req, res) => {
    try {
      const { DEFAULT_CONFIG } = await import("../../services/config.js");
      await saveConfig(DEFAULT_CONFIG);
      sendJson(res, 200, { ok: true, data: DEFAULT_CONFIG });
    } catch (err) {
      sendError(res, 500, `Failed to reset config: ${err}`);
    }
  });
}
