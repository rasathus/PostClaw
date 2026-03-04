/**
 * Dashboard API Routes — Knowledge graph endpoints.
 *
 * GET    /api/graph        — Full graph data for D3 visualization
 * GET    /api/edges        — List edges
 * POST   /api/edges        — Create edge
 * DELETE /api/edges/:id    — Delete edge
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getSql } from "../../services/db.js";
import { GraphEdgeCreateSchema } from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerGraphRoutes(router: Router): void {
  // FULL GRAPH — nodes + edges for D3 force graph
  router.get("/api/graph", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const result = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      const nodes = await tx`
        SELECT id, content, category, tier, access_count, usefulness_score, is_archived
        FROM memory_semantic
        WHERE agent_id = ${agentId} AND is_archived = false
        ORDER BY created_at DESC
        LIMIT 200
      `;

      const edges = await tx`
        SELECT id, source_memory_id, target_memory_id, relationship_type, weight
        FROM entity_edges
        WHERE agent_id = ${agentId}
      `;

      return { nodes, edges };
    });

    // Filter to only include edges where both source and target exist in nodes
    const nodeIds = new Set(result.nodes.map((n: { id: string }) => n.id));
    const validEdges = result.edges.filter(
      (e: { source_memory_id: string; target_memory_id: string }) =>
        nodeIds.has(e.source_memory_id) && nodeIds.has(e.target_memory_id),
    );

    sendJson(res, 200, {
      ok: true,
      data: {
        nodes: result.nodes.map((n: any) => ({
          id: n.id,
          label: n.content.substring(0, 80),
          category: n.category,
          tier: n.tier,
          accessCount: n.access_count,
          score: n.usefulness_score,
        })),
        edges: validEdges.map((e: any) => ({
          id: e.id,
          source: e.source_memory_id,
          target: e.target_memory_id,
          relationship: e.relationship_type,
          weight: e.weight,
        })),
      },
    });
  });

  // LIST EDGES
  router.get("/api/edges", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT e.id, e.source_memory_id, e.target_memory_id,
               e.relationship_type, e.weight, e.created_at,
               s.content AS source_content, t.content AS target_content
        FROM entity_edges e
        LEFT JOIN memory_semantic s ON e.source_memory_id = s.id
        LEFT JOIN memory_semantic t ON e.target_memory_id = t.id
        WHERE e.agent_id = ${agentId}
        ORDER BY e.created_at DESC
        LIMIT 200
      `;
    });

    sendJson(res, 200, { ok: true, data: rows });
  });

  // CREATE EDGE
  router.post("/api/edges", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = GraphEdgeCreateSchema.parse(body);
      const sql = getSql();

      const rows = await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
        return await tx`
          INSERT INTO entity_edges (
            agent_id, source_memory_id, target_memory_id, relationship_type, weight
          ) VALUES (
            ${agentId}, ${data.source_memory_id}, ${data.target_memory_id},
            ${data.relationship_type}, ${data.weight}
          )
          ON CONFLICT (source_memory_id, target_memory_id, relationship_type) DO NOTHING
          RETURNING id
        `;
      });

      if (rows.length === 0) {
        return sendJson(res, 200, { ok: true, data: { status: "already_exists" } });
      }
      sendJson(res, 201, { ok: true, data: { id: rows[0].id } });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Create failed");
    }
  });

  // DELETE EDGE
  router.delete("/api/edges/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        DELETE FROM entity_edges
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        RETURNING id
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Edge not found");
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  });
}
