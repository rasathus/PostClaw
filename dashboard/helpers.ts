/**
 * Dashboard HTTP Helpers — Shared utilities for the dashboard server.
 *
 * parseBody(), sendJson(), sendError(), serveStatic()
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

// =============================================================================
// MIME TYPES
// =============================================================================

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// =============================================================================
// BODY PARSING
// =============================================================================

/**
 * Parse the request body as JSON. Returns null if body is empty or invalid.
 */
export async function parseBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/**
 * Send a JSON response with the standard { ok, data?, error? } shape.
 */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: { ok: boolean; data?: unknown; error?: string },
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

/**
 * Send an error response.
 */
export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { ok: false, error: message });
}

// =============================================================================
// STATIC FILE SERVING
// =============================================================================

/**
 * Serve a static file from the given base directory.
 * Returns true if the file was served, false if not found.
 */
export async function serveStatic(
  res: ServerResponse,
  baseDirs: string[],
  requestPath: string,
): Promise<boolean> {
  // Normalize path — prevent directory traversal
  const safePath = requestPath.replace(/\.\./g, "").replace(/\/+/g, "/");
  const filePath = safePath === "/" ? "/index.html" : safePath;

  for (const baseDir of baseDirs) {
    const fullPath = join(baseDir, filePath);
    try {
      const content = await readFile(fullPath);
      const ext = extname(fullPath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
      });
      res.end(content);
      return true;
    } catch {
      // File not found in this dir, try next
    }
  }
  return false;
}

// =============================================================================
// QUERY STRING PARSING
// =============================================================================

/**
 * Parse query parameters from a URL string.
 */
export function parseQuery(url: string): Record<string, string> {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return {};
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.substring(qIndex + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}
