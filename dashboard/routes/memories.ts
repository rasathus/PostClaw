/**
 * Dashboard API Routes — Memory management endpoints.
 *
 * GET    /api/memories           — List memories (paginated, filterable)
 * POST   /api/memories           — Create memory
 * PUT    /api/memories/:id       — Update memory
 * DELETE /api/memories/:id       — Archive memory
 * POST   /api/memories/import    — Import from markdown content
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getSql, getEmbedding, hashContent, EMBEDDING_MODEL } from "../../services/db.js";
import { ensureAgent, storeMemory } from "../../services/memoryService.js";
import {
  MemoryListQuerySchema,
  DashboardMemoryCreateSchema,
  DashboardMemoryUpdateSchema,
  MemoryImportSchema,
} from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerMemoryRoutes(router: Router): void {
  // SEARCH — Combined text + semantic search for both memories and personas
  router.get("/api/memories/search", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const q = ctx.query.search || "";
    if (q.length < 2) return sendJson(res, 200, { ok: true, data: [] });

    const sql = getSql();
    try {
      const embedding = await getEmbedding(q);

      const rows = await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

        // Search both memories and personas by cosine distance
        return await tx`
          WITH memory_matches AS (
            SELECT id, content, 'memory' as type, 
                   1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
            FROM memory_semantic
            WHERE agent_id = ${agentId} AND is_archived = false
          ),
          persona_matches AS (
            SELECT id, ('[' || category || '] ' || content)::text as content, 'persona' as type,
                   1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
            FROM agent_persona
            WHERE agent_id = ${agentId}
          )
          SELECT id, content, type, similarity
          FROM (
            SELECT * FROM memory_matches
            UNION ALL
            SELECT * FROM persona_matches
          ) combined
          ORDER BY similarity DESC
          LIMIT 15
        `;
      });
      sendJson(res, 200, { ok: true, data: rows });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Search failed");
    }
  });

  // LIST — paginated, filterable
  router.get("/api/memories", async (_req, res, ctx) => {
    const q = MemoryListQuerySchema.parse(ctx.query);
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${q.agentId}, true)`;

      // Build dynamic WHERE clauses using parameterised template fragments — no unsafe() or string interpolation
      const archivedCondition =
        q.archived === "false" ? tx`AND is_archived = false` :
        q.archived === "true"  ? tx`AND is_archived = true`  : tx``;
      const categoryCondition = q.category ? tx`AND category    = ${q.category}` : tx``;
      const tierCondition     = q.tier     ? tx`AND tier        = ${q.tier}`     : tx``;
      const searchCondition   = q.search   ? tx`AND content ILIKE ${'%' + q.search + '%'}` : tx``;

      return await tx`
        SELECT id, agent_id, access_scope, content, content_hash, category, source_uri, volatility, is_pointer, embedding, embedding_model, token_count, confidence, tier, usefulness_score, injection_count, access_count, last_injected_at, last_accessed_at, created_at, updated_at, expires_at, is_archived, metadata, superseded_by
        FROM memory_semantic
        WHERE agent_id = ${q.agentId}
        ${archivedCondition}
        ${categoryCondition}
        ${tierCondition}
        ${searchCondition}
        ORDER BY created_at DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `;
    });

    // Also get total count
    const countResult = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${q.agentId}, true)`;
      const archived = q.archived === "true" ? true : q.archived === "false" ? false : null;
      if (archived === null) {
        return await tx`SELECT count(*)::int as total FROM memory_semantic WHERE agent_id = ${q.agentId}`;
      }
      return await tx`SELECT count(*)::int as total FROM memory_semantic WHERE agent_id = ${q.agentId} AND is_archived = ${archived}`;
    });

    sendJson(res, 200, {
      ok: true,
      data: { memories: rows, total: countResult[0]?.total || 0 },
    });
  });

  // CREATE
  router.post("/api/memories", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = DashboardMemoryCreateSchema.parse(body);
      await ensureAgent(agentId);
      const result = await storeMemory(agentId, data.content, data.scope, {
        category: data.category,
        tier: data.tier,
        volatility: data.volatility,
        metadata: data.metadata,
      });
      sendJson(res, 201, { ok: true, data: result });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Create failed");
    }
  });

  // UPDATE
  router.put("/api/memories/:id", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = DashboardMemoryUpdateSchema.parse(body);
      const sql = getSql();

      const rows = await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

        const current = await tx`
          SELECT * FROM memory_semantic WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        `;
        if (current.length === 0) return [];

        // Re-embed if content changed
        let embedding = current[0].embedding;
        let contentHash = current[0].content_hash;
        if (data.embedding !== undefined) {
          embedding = typeof data.embedding === "string" ? data.embedding : JSON.stringify(data.embedding);
        } else if (data.content && data.content !== current[0].content) {
          embedding = JSON.stringify(await getEmbedding(data.content));
        }

        if (data.content_hash !== undefined) {
          contentHash = data.content_hash;
        } else if (data.content && data.content !== current[0].content) {
          contentHash = hashContent(data.content);
        }

        return await tx`
          UPDATE memory_semantic SET
            agent_id = ${data.agent_id ?? current[0].agent_id},
            access_scope = ${data.access_scope ?? current[0].access_scope},
            content = ${data.content ?? current[0].content},
            content_hash = ${contentHash},
            category = ${data.category !== undefined ? data.category : current[0].category},
            source_uri = ${data.source_uri !== undefined ? data.source_uri : current[0].source_uri},
            volatility = ${data.volatility ?? current[0].volatility},
            is_pointer = ${data.is_pointer ?? current[0].is_pointer},
            embedding = ${embedding},
            embedding_model = ${data.embedding_model ?? current[0].embedding_model},
            token_count = ${data.token_count ?? current[0].token_count},
            confidence = ${data.confidence ?? current[0].confidence},
            tier = ${data.tier ?? current[0].tier},
            usefulness_score = ${data.usefulness_score ?? current[0].usefulness_score},
            injection_count = ${data.injection_count ?? current[0].injection_count},
            access_count = ${data.access_count ?? current[0].access_count},
            last_injected_at = ${data.last_injected_at !== undefined ? data.last_injected_at : current[0].last_injected_at},
            last_accessed_at = ${data.last_accessed_at !== undefined ? data.last_accessed_at : current[0].last_accessed_at},
            created_at = ${data.created_at ?? current[0].created_at},
            updated_at = ${data.updated_at ?? current[0].updated_at},
            expires_at = ${data.expires_at !== undefined ? data.expires_at : current[0].expires_at},
            is_archived = ${data.is_archived ?? current[0].is_archived},
            metadata = ${data.metadata !== undefined ? (data.metadata ? JSON.stringify(data.metadata) : null) : current[0].metadata},
            superseded_by = ${data.superseded_by !== undefined ? data.superseded_by : current[0].superseded_by}
          WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
          RETURNING *
        `;
      });

      if (rows.length === 0) return sendError(res, 404, "Memory not found");
      sendJson(res, 200, { ok: true, data: rows[0] });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Update failed");
    }
  });

  // GET ONE
  router.get("/api/memories/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT id, agent_id, access_scope, content, content_hash, category, source_uri, volatility, is_pointer, embedding, embedding_model, token_count, confidence, tier, usefulness_score, injection_count, access_count, last_injected_at, last_accessed_at, created_at, updated_at, expires_at, is_archived, metadata, superseded_by
        FROM memory_semantic
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Memory not found");
    sendJson(res, 200, { ok: true, data: rows[0] });
  });

  // EDGES for a specific memory
  router.get("/api/memories/:id/edges", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const memoryId = ctx.params.id;
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT e.id, e.source_memory_id, e.target_memory_id,
               e.source_persona_id, e.target_persona_id,
               e.relationship_type, e.weight, e.created_at,
               s.content AS source_content, t.content AS target_content,
               sp.category AS source_persona_category, tp.category AS target_persona_category
        FROM entity_edges e
        LEFT JOIN memory_semantic s ON e.source_memory_id = s.id
        LEFT JOIN memory_semantic t ON e.target_memory_id = t.id
        LEFT JOIN agent_persona sp ON e.source_persona_id = sp.id
        LEFT JOIN agent_persona tp ON e.target_persona_id = tp.id
        WHERE e.agent_id = ${agentId}
          AND (e.source_memory_id = ${memoryId} OR e.target_memory_id = ${memoryId})
        ORDER BY e.created_at DESC
      `;
    });

    sendJson(res, 200, { ok: true, data: rows });
  });

  // DELETE (archive)
  router.delete("/api/memories/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        UPDATE memory_semantic SET is_archived = true
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        RETURNING id
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Memory not found");
    sendJson(res, 200, { ok: true, data: { archived: true } });
  });

  // IMPORT from markdown
  router.post("/api/memories/import", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = MemoryImportSchema.parse(body);
      await ensureAgent(agentId);

      // Split markdown by headings, keeping each heading attached to its body
      const normalised = data.content.replace(/\r\n?/g, "\n");
      const chunks = normalised
        .split(/(?=^#{1,3}\s)/m)
        .map((section) => section.trim())
        .filter((s) => s.length > 10)
        .flatMap((section) => {
          // If section has a heading followed by body paragraphs, prefix each paragraph with the heading
          const match = section.match(/^(#{1,3}\s+.+)\n+([\s\S]*)$/);
          if (!match || !match[2].trim()) return [section];
          const heading = match[1];
          return match[2].split(/\n{2,}/)
            .map((p) => p.trim())
            .filter((p) => p.length > 10)
            .map((p) => `${heading}\n${p}`);
        });

      const results = [];
      for (const chunk of chunks) {
        const result = await storeMemory(agentId, chunk, "private", {
          tier: data.tier,
          source_uri: data.source_filename,
          category: "imported",
        });
        results.push(result);
      }

      sendJson(res, 201, {
        ok: true,
        data: { imported: results.length, chunks: results },
      });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Import failed");
    }
  });
}
