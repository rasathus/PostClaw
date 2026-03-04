/**
 * Dashboard API Routes — Workspace & agent endpoints.
 *
 * GET /api/agents                      — List agents
 * GET /api/workspace-files             — List .md files from workspace dir
 * GET /api/workspace-files/:filename   — Read workspace .md file content
 */

import { Router } from "../router.js";
import { sendJson, sendError } from "../helpers.js";
import { getSql } from "../../services/db.js";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";

// =============================================================================
// CONFIG — workspace directory (set during startup)
// =============================================================================

let _workspaceDir: string | null = null;

export function setWorkspaceDir(dir: string): void {
  _workspaceDir = dir;
}

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerWorkspaceRoutes(router: Router): void {
  // LIST AGENTS
  router.get("/api/agents", async (_req, res) => {
    try {
      const sql = getSql();
      const rows = await sql`
        SELECT id, name, is_active, created_at FROM agents ORDER BY created_at ASC
      `;
      sendJson(res, 200, { ok: true, data: rows });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Failed to list agents");
    }
  });

  // LIST WORKSPACE .md FILES
  router.get("/api/workspace-files", async (_req, res) => {
    if (!_workspaceDir) {
      return sendJson(res, 200, { ok: true, data: [] });
    }

    try {
      const entries = await readdir(_workspaceDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".md")
        .map((e) => ({
          name: e.name,
          path: join(_workspaceDir!, e.name),
        }));
      sendJson(res, 200, { ok: true, data: mdFiles });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Failed to read workspace");
    }
  });

  // READ WORKSPACE .md FILE
  router.get("/api/workspace-files/:filename", async (_req, res, ctx) => {
    if (!_workspaceDir) {
      return sendError(res, 404, "Workspace directory not configured");
    }

    const filename = ctx.params.filename;

    // Security: only allow .md files, no path traversal
    if (!filename.endsWith(".md") || filename.includes("..") || filename.includes("/")) {
      return sendError(res, 400, "Only .md files allowed, no path traversal");
    }

    try {
      const content = await readFile(join(_workspaceDir, filename), "utf-8");
      sendJson(res, 200, { ok: true, data: { name: filename, content } });
    } catch {
      sendError(res, 404, `File not found: ${filename}`);
    }
  });
}
