/**
 * Tests for the dashboard Router — path matching, param extraction, and CORS.
 */

import { describe, it, expect, vi } from "vitest";
import { Router } from "../dashboard/router.js";
import { IncomingMessage, ServerResponse } from "node:http";

// =============================================================================
// HELPERS — Mock request/response
// =============================================================================

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  } as unknown as ServerResponse;
  return res;
}

// =============================================================================
// TESTS
// =============================================================================

describe("Router.match", () => {
  it("matches a simple GET route", () => {
    const router = new Router();
    const handler = vi.fn();
    router.get("/api/test", handler);

    const result = router.match("GET", "/api/test");
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({});
  });

  it("extracts path parameters", () => {
    const router = new Router();
    router.get("/api/items/:id", vi.fn());

    const result = router.match("GET", "/api/items/abc-123");
    expect(result).not.toBeNull();
    expect(result!.params.id).toBe("abc-123");
  });

  it("extracts multiple path parameters", () => {
    const router = new Router();
    router.get("/api/:type/:id", vi.fn());

    const result = router.match("GET", "/api/memories/uuid-here");
    expect(result).not.toBeNull();
    expect(result!.params.type).toBe("memories");
    expect(result!.params.id).toBe("uuid-here");
  });

  it("returns null for non-matching method", () => {
    const router = new Router();
    router.get("/api/test", vi.fn());

    expect(router.match("POST", "/api/test")).toBeNull();
  });

  it("returns null for non-matching path", () => {
    const router = new Router();
    router.get("/api/test", vi.fn());

    expect(router.match("GET", "/api/other")).toBeNull();
  });

  it("handles URL-encoded params", () => {
    const router = new Router();
    router.get("/api/files/:filename", vi.fn());

    const result = router.match("GET", "/api/files/hello%20world.md");
    expect(result).not.toBeNull();
    expect(result!.params.filename).toBe("hello world.md");
  });
});

describe("Router.handle", () => {
  it("calls the matched handler", async () => {
    const router = new Router();
    const handler = vi.fn().mockResolvedValue(undefined);
    router.get("/api/test", handler);

    const handled = await router.handle(mockReq("GET", "/api/test"), mockRes());
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns false when no route matches", async () => {
    const router = new Router();
    const handled = await router.handle(mockReq("GET", "/api/unknown"), mockRes());
    expect(handled).toBe(false);
  });

  it("handles CORS preflight", async () => {
    const router = new Router();
    const res = mockRes();
    const handled = await router.handle(mockReq("OPTIONS", "/api/test"), res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(204, expect.objectContaining({
      "Access-Control-Allow-Origin": "*",
    }));
  });

  it("extracts query parameters", async () => {
    const router = new Router();
    let capturedCtx: any;
    router.get("/api/test", async (_req, _res, ctx) => { capturedCtx = ctx; });

    await router.handle(mockReq("GET", "/api/test?foo=bar&baz=qux"), mockRes());
    expect(capturedCtx.query.foo).toBe("bar");
    expect(capturedCtx.query.baz).toBe("qux");
  });

  it("catches handler errors and sends 500", async () => {
    const router = new Router();
    router.get("/api/fail", async () => { throw new Error("oops"); });

    const res = mockRes();
    const handled = await router.handle(mockReq("GET", "/api/fail"), res);
    expect(handled).toBe(true);
    // sendError will call res.writeHead with 500
    expect(res.writeHead).toHaveBeenCalled();
  });
});

describe("Router shorthand methods", () => {
  it("registers POST routes", () => {
    const router = new Router();
    router.post("/api/create", vi.fn());
    expect(router.match("POST", "/api/create")).not.toBeNull();
  });

  it("registers PUT routes", () => {
    const router = new Router();
    router.put("/api/update/:id", vi.fn());
    expect(router.match("PUT", "/api/update/123")).not.toBeNull();
  });

  it("registers DELETE routes", () => {
    const router = new Router();
    router.delete("/api/remove/:id", vi.fn());
    expect(router.match("DELETE", "/api/remove/123")).not.toBeNull();
  });
});
