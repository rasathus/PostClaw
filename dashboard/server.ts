/**
 * PostClaw Dashboard Server — HTTP server lifecycle.
 *
 * Serves the dashboard UI and REST API on a configurable port.
 * Follows the same start/stop pattern as the sleep cycle service.
 */

import { createServer, Server } from "node:http";
import { join, dirname } from "node:path";
import { Router } from "./router.js";
import { serveStatic, sendError } from "./helpers.js";
import { registerPersonaRoutes } from "./routes/personas.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerScriptRoutes } from "./routes/scripts.js";
import { registerWorkspaceRoutes, setWorkspaceDir } from "./routes/workspace.js";
import { registerConfigRoutes } from "./routes/config.js";
import { setWorkspaceDir as setSvcWorkspaceDir } from "../services/config.js";

// =============================================================================
// SERVER STATE
// =============================================================================

let _server: Server | null = null;
const DEFAULT_PORT = 3333;
const DEFAULT_BIND = "127.0.0.1";

// =============================================================================
// STARTUP
// =============================================================================

export interface DashboardOptions {
  port?: number;
  bindAddress?: string;
  workspaceDir?: string;
}

export function startDashboard(opts: DashboardOptions = {}): void {
  if (_server) {
    console.log("[Dashboard] Already running, skipping start");
    return;
  }

  const port = opts.port || DEFAULT_PORT;
  const bind = opts.bindAddress || DEFAULT_BIND;

  // Security warning for non-localhost binds
  if (bind !== "127.0.0.1" && bind !== "localhost") {
    console.warn(`[Dashboard] ⚠️  WARNING: Binding to ${bind} exposes the dashboard to the network!`);
    console.warn(`[Dashboard] ⚠️  The dashboard has NO authentication. Only bind to 0.0.0.0 on trusted networks.`);
  }

  // Set workspace dir for file listing and svc config
  if (opts.workspaceDir) {
    setWorkspaceDir(opts.workspaceDir);
    setSvcWorkspaceDir(opts.workspaceDir);
  }

  // Build router and register all routes
  const router = new Router();
  registerPersonaRoutes(router);
  registerMemoryRoutes(router);
  registerGraphRoutes(router);
  registerScriptRoutes(router);
  registerWorkspaceRoutes(router);
  registerConfigRoutes(router);

  // Resolve static file directories
  // At runtime __dirname = dist/dashboard/, so go up 2 levels to project root
  // Static files are NOT compiled by tsc — they live in dashboard/public/
  const projectRoot = join(dirname(__filename), "..", "..");
  const publicDir = join(projectRoot, "dashboard", "public");
  const ambientDir = join(projectRoot, "node_modules", "@ambientcss", "css");

  _server = createServer(async (req, res) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];

    // API routes
    if (pathname.startsWith("/api/")) {
      const handled = await router.handle(req, res);
      if (!handled) sendError(res, 404, "Not found");
      return;
    }

    // Serve AmbientCSS assets under /vendor/
    if (pathname.startsWith("/vendor/ambient")) {
      const vendorPath = pathname.replace("/vendor/ambient", "");
      const served = await serveStatic(res, [ambientDir], vendorPath || "/ambient.css");
      if (!served) sendError(res, 404, "Vendor file not found");
      return;
    }

    // Static files
    const served = await serveStatic(res, [publicDir], pathname);
    if (!served) {
      // SPA fallback — serve index.html for any unmatched path
      const fallback = await serveStatic(res, [publicDir], "/index.html");
      if (!fallback) sendError(res, 404, "Dashboard files not found");
    }
  });

  _server.listen(port, bind, () => {
    console.log(`[Dashboard] 🖥️  Dashboard running at http://${bind}:${port}`);
  });

  _server.on("error", (err) => {
    console.error("[Dashboard] Server error:", err);
  });
}

// =============================================================================
// SHUTDOWN
// =============================================================================

export function stopDashboard(): void {
  if (_server) {
    _server.close(() => {
      console.log("[Dashboard] Server stopped");
    });
    _server = null;
  }
}
