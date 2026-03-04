/**
 * Tests for dashboard HTTP helpers — body parsing, JSON responses, query parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { parseQuery } from "../dashboard/helpers.js";
import { ServerResponse } from "node:http";

// =============================================================================
// parseQuery
// =============================================================================

describe("parseQuery", () => {
  it("returns empty object for no query string", () => {
    expect(parseQuery("/api/test")).toEqual({});
  });

  it("parses single parameter", () => {
    expect(parseQuery("/api/test?agentId=main")).toEqual({ agentId: "main" });
  });

  it("parses multiple parameters", () => {
    const result = parseQuery("/api/test?limit=10&offset=5&search=hello");
    expect(result).toEqual({ limit: "10", offset: "5", search: "hello" });
  });

  it("handles URL-encoded values", () => {
    const result = parseQuery("/api/test?q=hello%20world");
    expect(result.q).toBe("hello world");
  });

  it("handles empty value", () => {
    const result = parseQuery("/api/test?key=");
    expect(result.key).toBe("");
  });

  it("handles path with no query at all", () => {
    expect(parseQuery("/")).toEqual({});
  });
});

// =============================================================================
// sendJson (via integration — just verifying the shape)
// =============================================================================

describe("sendJson shape", () => {
  it("produces correct response shape", async () => {
    // Import dynamically to test the function
    const { sendJson } = await import("../dashboard/helpers.js");

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    sendJson(res, 200, { ok: true, data: { test: 1 } });

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "application/json; charset=utf-8",
    }));

    const body = JSON.parse((res.end as any).mock.calls[0][0]);
    expect(body.ok).toBe(true);
    expect(body.data.test).toBe(1);
  });

  it("sends error shape", async () => {
    const { sendError } = await import("../dashboard/helpers.js");

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    sendError(res, 404, "Not found");

    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    const body = JSON.parse((res.end as any).mock.calls[0][0]);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });
});
