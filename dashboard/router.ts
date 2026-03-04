/**
 * Dashboard Router — Lightweight path-based routing for the dashboard API.
 *
 * Supports path parameters like /api/memories/:id and method matching.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface RouteParams {
  [key: string]: string;
}

export interface RouteContext {
  params: RouteParams;
  query: Record<string, string>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

// =============================================================================
// ROUTER
// =============================================================================

export class Router {
  private routes: Route[] = [];

  /**
   * Register a route. Supports :param syntax for path parameters.
   */
  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:([a-zA-Z_]+)/g, (_match, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  /** Shorthand route registration */
  get(path: string, handler: RouteHandler): void { this.add("GET", path, handler); }
  post(path: string, handler: RouteHandler): void { this.add("POST", path, handler); }
  put(path: string, handler: RouteHandler): void { this.add("PUT", path, handler); }
  delete(path: string, handler: RouteHandler): void { this.add("DELETE", path, handler); }

  /**
   * Match an incoming request against registered routes.
   * Returns the handler and extracted params, or null if no match.
   */
  match(method: string, pathname: string): { handler: RouteHandler; params: RouteParams } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: RouteParams = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  /**
   * Handle an incoming request. Returns true if a route matched.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    const method = req.method || "GET";

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return true;
    }

    const result = this.match(method, pathname);
    if (!result) return false;

    const query: Record<string, string> = {};
    const qIndex = url.indexOf("?");
    if (qIndex !== -1) {
      const searchParams = new URLSearchParams(url.substring(qIndex + 1));
      for (const [key, value] of searchParams) {
        query[key] = value;
      }
    }

    try {
      await result.handler(req, res, { params: result.params, query });
    } catch (err) {
      console.error("[Dashboard] Route error:", err);
      sendError(res, 500, err instanceof Error ? err.message : "Internal server error");
    }
    return true;
  }
}
