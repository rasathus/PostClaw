/**
 * PostClaw Sleep Cycle — Knowledge Graph Maintenance Agent
 *
 * Runs 4 maintenance phases on the memory database:
 *   1. Episodic Consolidation — extract durable facts from short-term memory
 *   2. Duplicate Detection — find and merge near-duplicate semantic memories
 *   3. Low-Value Cleanup — archive stale, unaccessed memories
 *   4. Link Discovery — auto-discover and create knowledge graph edges
 *
 * Usage (via OpenClaw CLI):
 *   openclaw postclaw sleep [--agent-id <id>]
 *
 * Also runs as a background service on a configurable interval when the
 * gateway is running (default: every 6 hours).
 */

import { getSql, getEmbedding, LM_STUDIO_URL, validateEmbeddingDimension } from "../services/db.js";
import { ensureAgent } from "../services/memoryService.js";
import { loadConfig } from "../services/config.js";
import { sendPromptViaACP } from "../src/acp-client.js";
import {
  SleepCycleResultSchema,
  type SleepCycleResult,
  type EpisodicRow,
  type DuplicateCandidateRow,
  type StaleMemoryRow,
} from "../schemas/validation.js";

// =============================================================================
// CONFIGURATION — All thresholds are easily tunable here
// =============================================================================

// Phase 1: Episodic consolidation
const DEFAULT_EPISODIC_BATCH_LIMIT = 100;

// Phase 2: Duplicate detection
const DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD = 0.80;
const DEFAULT_DUPLICATE_SCAN_LIMIT = 200;

// Phase 3: Low-value cleanup
const DEFAULT_LOW_VALUE_AGE_DAYS = 7;
const DEFAULT_LOW_VALUE_PROTECTED_TIERS = ['permanent', 'stable'];

// Phase 4: Link discovery
const DEFAULT_LINK_SIMILARITY_MIN = 0.65;
const DEFAULT_LINK_SIMILARITY_MAX = 0.92;
const DEFAULT_LINK_CANDIDATES_PER_MEMORY = 5;
const DEFAULT_LINK_BATCH_SIZE = 20;
const DEFAULT_LINK_SCAN_LIMIT = 50;

// Background service
const DEFAULT_INTERVAL_HOURS = 6;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Defensively extracts a JSON object from raw LLM output.
 * Handles markdown fences (```json ... ```) or conversational filler 
 * wrapping the actual { ... } block.
 */
function extractJsonFromLlmOutput(text: string): string {
  if (!text) return "";

  // 1. Try to find a fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }

  // 2. Try to find the outermost curly braces or square brackets
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  
  const firstIdx = Math.min(
    firstBrace === -1 ? Infinity : firstBrace,
    firstBracket === -1 ? Infinity : firstBracket
  );
  
  if (firstIdx !== Infinity) {
    const isArray = firstIdx === firstBracket;
    const lastIdx = isArray ? lastBracket : lastBrace;
    if (lastIdx !== -1 && lastIdx > firstIdx) {
      return text.substring(firstIdx, lastIdx + 1).trim();
    }
  }

  // 3. Fallback to just returning the trimmed string and letting JSON.parse try
  return text.trim();
}

// SleepCycleResult and LinkClassification types are now imported from schemas

export interface SleepCycleOptions {
  agentId?: string;
  config?: {
    episodicBatchLimit?: number;
    duplicateSimilarityThreshold?: number;
    duplicateScanLimit?: number;
    lowValueAgeDays?: number;
    lowValueProtectedTiers?: string[];
    linkSimilarityMin?: number;
    linkSimilarityMax?: number;
    linkCandidatesPerMemory?: number;
    linkBatchSize?: number;
    linkScanLimit?: number;
  };
}

export interface SleepCycleStats {
  factsExtracted: number;
  duplicatesMerged: number;
  staleArchived: number;
  expiredArchived: number;
  linksCreated: number;
}

// =============================================================================
// UTILITIES
// =============================================================================

// LLM calls now routed through OpenClaw's configured primary model via callLLMviaAgent

// =============================================================================
// PHASE 1: EPISODIC CONSOLIDATION
// =============================================================================

async function phaseConsolidateEpisodic(agentId: string, limit: number): Promise<number> {
  console.log(`\n[PHASE 1] Episodic Memory Consolidation`);
  console.log(`─────────────────────────────────────────`);

  const sql = getSql();

  const episodes = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, event_type, event_summary, created_at
      FROM memory_episodic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at ASC
      LIMIT ${limit};
    `;
  });

  if (episodes.length === 0) {
    console.log(`[PHASE 1] No new episodic memories to process.`);
    return 0;
  }

  console.log(`[PHASE 1] Found ${episodes.length} episodic events to consolidate.`);

  const systemPrompt = `
You are the subconscious memory consolidation engine for an AI assistant.
Your job is to review the following chronological transcript of the agent's recent short-term memory (user prompts and tool executions).

Extract ONLY durable, long-term facts that the agent should remember forever.
- Ignore casual banter, specific temporary weather lookups, or transient errors.
- DO extract user preferences, API keys, infrastructure details, or new project rules.

Output your response EXCLUSIVELY as a JSON object matching this schema:
{
  "session_summary": "A brief 2-sentence summary of what happened during this timeframe.",
  "extracted_durable_facts": ["fact 1", "fact 2"]
}
Do not use markdown formatting.
`;

  async function processChunk(chunk: any[]): Promise<SleepCycleResult> {
    const transcript = chunk
      .map((e: Record<string, unknown>) => {
        const row = e as EpisodicRow;
        return `[${row.created_at}] [${row.event_type.toUpperCase()}]: ${row.event_summary}`;
      })
      .join("\n");

    const prompt = `${systemPrompt}\n\nHere is the recent episodic transcript to analyze:\n\n${transcript}`;

    const jsonString = await sendPromptViaACP(prompt, agentId);

    try {
      const cleanString = extractJsonFromLlmOutput(jsonString);
      return SleepCycleResultSchema.parse(JSON.parse(cleanString));
    } catch (err: any) {
      console.error(`\n[PHASE 1] ❌ FATAL PARSE ERROR`);
      console.error(`The internal LLM response could not be parsed as valid JSON.`);
      console.error(`This blocks the promotion of short-term memories into semantic facts.\n`);
      console.error(`=== RAW LLM OUTPUT ===`);
      console.error(jsonString);
      console.error(`======================\n`);
      throw new Error(`Episodic consolidation parsing failed: ${err.message}`);
    }
  }

  const result: SleepCycleResult = await processChunk(episodes);

  console.log(`[PHASE 1] Extracted ${result.extracted_durable_facts.length} permanent facts.`);
  console.log(`[PHASE 1] Session Summary: ${result.session_summary}`);

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (const fact of result.extracted_durable_facts) {
      const embedding = await getEmbedding(fact);
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(fact));
      const contentHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model, tier
        ) VALUES (
          ${agentId}, 'private', ${fact}, ${contentHash}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe', 'permanent'
        ) ON CONFLICT (agent_id, content_hash) DO NOTHING;
      `;
      console.log(`[PHASE 1] -> Saved durable fact: "${fact}"`);
    }

    const episodeIds = (episodes as EpisodicRow[]).map((e) => e.id);
    await tx`
      UPDATE memory_episodic
      SET is_archived = true
      WHERE id IN ${sql(episodeIds)}
    `;
  });

  console.log(`[PHASE 1] Archived ${episodes.length} short-term memories. Consolidation complete.`);
  return result.extracted_durable_facts.length;
}

// =============================================================================
// PHASE 2: DUPLICATE DETECTION & MERGE
// =============================================================================

async function phaseDuplicateDetection(agentId: string, options: { threshold: number; scanLimit: number }): Promise<number> {
  console.log(`\n[PHASE 2] Duplicate Detection & Merge`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 2] Similarity threshold: ${options.threshold}`);

  const sql = getSql();

  const memories = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, content, embedding, usefulness_score, access_count, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${options.scanLimit};
    `;
  });

  if (memories.length < 2) {
    console.log(`[PHASE 2] Not enough memories to scan for duplicates (${memories.length}).`);
    return 0;
  }

  console.log(`[PHASE 2] Scanning ${memories.length} memories for duplicates...`);

  let mergedCount = 0;
  const archivedIds = new Set<string>();

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (let i = 0; i < memories.length; i++) {
      const source = memories[i];
      if (archivedIds.has(source.id)) continue;

      const duplicates = await tx`
        SELECT id, content, usefulness_score, access_count, confidence, volatility, injection_count
        FROM memory_semantic
        WHERE agent_id = ${agentId}
          AND is_archived = false
          AND id != ${source.id}
          AND 1 - (embedding <=> ${source.embedding}) > ${options.threshold}
        ORDER BY usefulness_score DESC, access_count DESC
        LIMIT 10;
      `;

      if (duplicates.length === 0) continue;

      const allCandidates = [source, ...duplicates];
      // Score survivors using ALL relevant DB columns:
      // usefulness_score, access_count, confidence, injection_count, volatility
      allCandidates.sort((a, b) => {
        const rowA = a as DuplicateCandidateRow;
        const rowB = b as DuplicateCandidateRow;
        const volPenA = rowA.volatility === 'high' ? -0.5 : rowA.volatility === 'medium' ? -0.2 : 0;
        const volPenB = rowB.volatility === 'high' ? -0.5 : rowB.volatility === 'medium' ? -0.2 : 0;
        const scoreA = (rowA.usefulness_score || 0) + (rowA.access_count || 0) * 0.1
          + (rowA.confidence || 0.5) * 0.5 + (rowA.injection_count || 0) * 0.05 + volPenA;
        const scoreB = (rowB.usefulness_score || 0) + (rowB.access_count || 0) * 0.1
          + (rowB.confidence || 0.5) * 0.5 + (rowB.injection_count || 0) * 0.05 + volPenB;
        return scoreB - scoreA;
      });

      const survivor = allCandidates[0];
      const losers = allCandidates.slice(1);

      for (const loser of losers) {
        if (archivedIds.has(loser.id)) continue;

        await tx`
          UPDATE memory_semantic
          SET is_archived = true, superseded_by = ${survivor.id}
          WHERE id = ${loser.id} AND agent_id = ${agentId};
        `;
        archivedIds.add(loser.id);
        mergedCount++;
        console.log(`[PHASE 2] -> Merged duplicate: "${loser.content.substring(0, 60)}..." → survivor ${survivor.id.substring(0, 8)}`);
      }
    }
  });

  console.log(`[PHASE 2] Merged ${mergedCount} duplicate memories.`);
  return mergedCount;
}

// =============================================================================
// PHASE 3: LOW-VALUE ENTRY CLEANUP
// =============================================================================

async function phaseLowValueCleanup(agentId: string, options: { ageDays: number; protectedTiers: string[] }): Promise<number> {
  console.log(`\n[PHASE 3] Low-Value Entry Cleanup`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 3] Archiving memories with 0 access older than ${options.ageDays} days (protecting: ${options.protectedTiers.join(', ')})`);

  const sql = getSql();

  const result = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    // Also archive memories past their expires_at date
    const expiredRows = await tx`
      UPDATE memory_semantic
      SET is_archived = true
      WHERE agent_id = ${agentId}
        AND is_archived = false
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
      RETURNING id, content, tier;
    `;
    if (expiredRows.length > 0) {
      for (const m of expiredRows) {
        console.log(`[PHASE 3] -> Archived expired: "${m.content.substring(0, 60)}..." (tier=${m.tier})`);
      }
      console.log(`[PHASE 3] Archived ${expiredRows.length} expired memories.`);
    }

    // Low-value cleanup: consider access_count, injection_count, and confidence
    const staleMemories = await tx`
      SELECT id, content, tier, access_count, injection_count, confidence, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId}
        AND is_archived = false
        AND access_count = 0
        AND injection_count = 0
        AND confidence < 0.3
        AND created_at < NOW() - INTERVAL '1 day' * ${options.ageDays}
        AND tier NOT IN ${sql(options.protectedTiers)}
      ORDER BY confidence ASC, created_at ASC;
    `;

    if (staleMemories.length === 0) {
      return 0;
    }

    const staleIds = staleMemories.map((m: { id: string }) => m.id);
    await tx`
      UPDATE memory_semantic
      SET is_archived = true
      WHERE id IN ${sql(staleIds)};
    `;

    for (const m of staleMemories as StaleMemoryRow[]) {
      console.log(`[PHASE 3] -> Archived stale: "${m.content.substring(0, 60)}..." (tier=${m.tier}, age=${Math.round((Date.now() - new Date(m.created_at).getTime()) / 86400000)}d)`);
    }

    return staleMemories.length + expiredRows.length;
  });

  console.log(`[PHASE 3] Archived ${result} total entries (low-value + expired).`);
  return result;
}

// =============================================================================
// PHASE 4: LINK CANDIDATE DISCOVERY & AUTO-LINKING
// =============================================================================

async function phaseLinkDiscovery(agentId: string, options: { min: number; max: number; candidatesPerMemory: number; batchSize: number; scanLimit: number }): Promise<number> {
  console.log(`\n[PHASE 4] Link Candidate Discovery & Auto-Linking`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 4] Similarity range: ${options.min}–${options.max}`);

  const sql = getSql();

  // Fetch both memories and persona traits
  const [sourceMemories, personaTraits] = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    const memories = await tx`
      SELECT id, content, embedding
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${options.scanLimit};
    `;
    const personas = await tx`
      SELECT id, category, content, embedding
      FROM agent_persona
      WHERE agent_id = ${agentId}
    `;
    return [memories, personas];
  });

  if (sourceMemories.length < 2 && personaTraits.length === 0) {
    console.log(`[PHASE 4] Not enough entries for link discovery (${sourceMemories.length} memories, ${personaTraits.length} persona traits).`);
    return 0;
  }

  console.log(`[PHASE 4] Scanning ${sourceMemories.length} memories + ${personaTraits.length} persona traits for link candidates...`);

  interface CandidatePair {
    source_id: string;
    source_content: string;
    source_type: "memory" | "persona";
    target_id: string;
    target_content: string;
    target_type: "memory" | "persona";
    similarity: number;
  }

  const candidatePairs: CandidatePair[] = [];
  const seenPairs = new Set<string>();

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    // 1) Memory ↔ Memory candidates (original behavior)
    for (const source of sourceMemories) {
      const candidates = await tx`
        SELECT m.id, m.content, 1 - (m.embedding <=> ${source.embedding}) AS similarity
        FROM memory_semantic m
        WHERE m.agent_id = ${agentId}
          AND m.is_archived = false
          AND m.id != ${source.id}
          AND 1 - (m.embedding <=> ${source.embedding}) BETWEEN ${options.min} AND ${options.max}
          AND NOT EXISTS (
            SELECT 1 FROM entity_edges e
            WHERE e.agent_id = ${agentId}
              AND (
                (e.source_memory_id = ${source.id} AND e.target_memory_id = m.id)
                OR (e.source_memory_id = m.id AND e.target_memory_id = ${source.id})
              )
          )
        ORDER BY similarity DESC
        LIMIT ${options.candidatesPerMemory};
    `;

      for (const candidate of candidates) {
        const pairKey = [source.id, candidate.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        candidatePairs.push({
          source_id: source.id,
          source_content: source.content,
          source_type: "memory",
          target_id: candidate.id,
          target_content: candidate.content,
          target_type: "memory",
          similarity: candidate.similarity,
        });
      }
    }

    // 2) Persona ↔ Memory cross-link candidates
    for (const persona of personaTraits) {
      if (!persona.embedding) continue; // skip personas without embeddings

      const candidates = await tx`
        SELECT m.id, m.content, 1 - (m.embedding <=> ${persona.embedding}) AS similarity
        FROM memory_semantic m
        WHERE m.agent_id = ${agentId}
          AND m.is_archived = false
          AND 1 - (m.embedding <=> ${persona.embedding}) BETWEEN ${options.min} AND ${options.max}
          AND NOT EXISTS (
            SELECT 1 FROM entity_edges e
            WHERE e.agent_id = ${agentId}
              AND (
                (e.source_persona_id = ${persona.id} AND e.target_memory_id = m.id)
                OR (e.source_memory_id = m.id AND e.target_persona_id = ${persona.id})
              )
          )
        ORDER BY similarity DESC
        LIMIT ${options.candidatesPerMemory};
      `;

      for (const candidate of candidates) {
        const pairKey = [persona.id, candidate.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        candidatePairs.push({
          source_id: persona.id,
          source_content: `[Persona: ${persona.category}] ${persona.content}`,
          source_type: "persona",
          target_id: candidate.id,
          target_content: candidate.content,
          target_type: "memory",
          similarity: candidate.similarity,
        });
      }
    }
  });

  if (candidatePairs.length === 0) {
    console.log(`[PHASE 4] No new link candidates found.`);
    return 0;
  }

  const memMemCount = candidatePairs.filter(p => p.source_type === "memory" && p.target_type === "memory").length;
  const crossCount = candidatePairs.length - memMemCount;
  console.log(`[PHASE 4] Found ${candidatePairs.length} candidate pairs (${memMemCount} memory↔memory, ${crossCount} persona↔memory). Classifying relationships...`);

  // POSTCLAW_FAST_LINKING=true skips LLM classification and uses similarity
  // thresholds instead. Useful for development or when LLM is unavailable.
  const fastLinking = process.env.POSTCLAW_FAST_LINKING === "true";

  // Classify all pairs via LLM (full 7-type vocabulary)
  const pairRelationships = new Map<string, string>();

  if (fastLinking) {
    console.log(`[PHASE 4] Fast-linking mode enabled. Using similarity thresholds.`);
    for (const pair of candidatePairs) {
      const pairKey = [pair.source_id, pair.target_id].join(":");
      pairRelationships.set(pairKey, pair.similarity >= 0.85 ? "strong_link" : "related_to");
    }
  } else {
    // Build a batch prompt for all pairs at once.
    const linkSystemPrompt = `You are a knowledge graph relationship classifier.
Given pairs of memory entries, classify the semantic relationship between each pair.

Use EXACTLY one of these relationship types:
- elaborates: one entry provides additional detail or context for the other
- contradicts: one entry conflicts with or disputes the other
- depends_on: one entry requires the other to be true or applicable
- part_of: one entry is a component, subset, or instance of the other
- defines: one entry provides the definition or meaning of the other
- supports: one entry provides evidence or reasoning that strengthens the other
- related_to: the entries are topically related but don't fit the above types

Output EXCLUSIVELY a JSON array (no markdown, no explanation) with one object per pair:
[
  { "pair_index": 0, "relationship": "<type>" },
  ...
]`;

    const pairsText = candidatePairs.map((pair, i) => (
      `Pair ${i}:\n  A: ${pair.source_content.substring(0, 500)}\n  B: ${pair.target_content.substring(0, 500)}`
    )).join("\n\n");

    const batchPrompt = `${linkSystemPrompt}\n\nPairs to classify:\n\n${pairsText}`;

    const validRelationships = new Set([
      "elaborates", "contradicts", "depends_on", "part_of",
      "defines", "supports", "related_to",
    ]);

    try {
      const jsonString = await sendPromptViaACP(batchPrompt, agentId);
      const cleanString = extractJsonFromLlmOutput(jsonString);
      const classifications = JSON.parse(cleanString) as Array<{ pair_index: number; relationship: string }>;

      for (const item of classifications) {
        const pair = candidatePairs[item.pair_index];
        if (!pair) continue;
        if (!validRelationships.has(item.relationship)) continue;
        const rel = item.relationship;
        pairRelationships.set([pair.source_id, pair.target_id].join(":"), rel);
      }
    } catch (err: any) {
      console.warn(`[PHASE 4] ⚠️ LLM classification failed: ${err.message}. No links will be created this cycle.`);
    }
    // Pairs not returned by the LLM are simply not linked — no fallback.
  }

  let linksCreated = 0;

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (const pair of candidatePairs) {
      const relationship = pairRelationships.get([pair.source_id, pair.target_id].join(":"));
      if (!relationship) continue;

      if (relationship === "none") continue;

      try {
        await tx`
          INSERT INTO entity_edges (
            agent_id,
            source_memory_id, target_memory_id,
            source_persona_id, target_persona_id,
            relationship_type, weight
          ) VALUES (
            ${agentId},
            ${pair.source_type === "memory" ? pair.source_id : null},
            ${pair.target_type === "memory" ? pair.target_id : null},
            ${pair.source_type === "persona" ? pair.source_id : null},
            ${pair.target_type === "persona" ? pair.target_id : null},
            ${relationship}, ${pair.similarity}
          )
          ON CONFLICT DO NOTHING;
        `;
        linksCreated++;
        const linkLabel = `${pair.source_type}/${pair.source_id.substring(0, 8)} → ${pair.target_type}/${pair.target_id.substring(0, 8)}`;
        console.log(`[PHASE 4] -> Linked: ${linkLabel} as "${relationship}"`);
      } catch (err) {
        console.error(`[PHASE 4] Failed to insert edge: ${err}`);
      }
    }
  });

  console.log(`[PHASE 4] Created ${linksCreated} new knowledge graph edges.`);
  return linksCreated;
}

// =============================================================================
// MAIN: RUN ALL PHASES
// =============================================================================

export async function runSleepCycle(opts: SleepCycleOptions = {}): Promise<SleepCycleStats> {
  const agentId = opts.agentId || "main";

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  SLEEP CYCLE — Knowledge Graph Maintenance Agent    ║`);
  console.log(`║  Agent: ${agentId.padEnd(44)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  await ensureAgent(agentId);

  const stats: SleepCycleStats = {
    factsExtracted: 0,
    duplicatesMerged: 0,
    staleArchived: 0,
    expiredArchived: 0,
    linksCreated: 0,
  };

  try {
    // Pre-flight check: ensure embedding model matches DB schema
    // If we consolidate with the wrong dimensions, PGVector insertion will crash
    const dimValidation = await validateEmbeddingDimension(agentId);
    if (!dimValidation.matches) {
       throw new Error(`Dimension mismatch: Model '${dimValidation.model}' provides ${dimValidation.actual} dims, DB expects ${dimValidation.expected}. Aborting sleep cycle to prevent semantic insertion failures.`);
    }

    stats.factsExtracted = await phaseConsolidateEpisodic(agentId, opts.config?.episodicBatchLimit ?? DEFAULT_EPISODIC_BATCH_LIMIT);
    stats.duplicatesMerged = await phaseDuplicateDetection(agentId, {
      threshold: opts.config?.duplicateSimilarityThreshold ?? DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD,
      scanLimit: opts.config?.duplicateScanLimit ?? DEFAULT_DUPLICATE_SCAN_LIMIT
    });
    stats.staleArchived = await phaseLowValueCleanup(agentId, {
      ageDays: opts.config?.lowValueAgeDays ?? DEFAULT_LOW_VALUE_AGE_DAYS,
      protectedTiers: opts.config?.lowValueProtectedTiers ?? DEFAULT_LOW_VALUE_PROTECTED_TIERS
    });
    stats.linksCreated = await phaseLinkDiscovery(agentId, {
      min: opts.config?.linkSimilarityMin ?? DEFAULT_LINK_SIMILARITY_MIN,
      max: opts.config?.linkSimilarityMax ?? DEFAULT_LINK_SIMILARITY_MAX,
      candidatesPerMemory: opts.config?.linkCandidatesPerMemory ?? DEFAULT_LINK_CANDIDATES_PER_MEMORY,
      batchSize: opts.config?.linkBatchSize ?? DEFAULT_LINK_BATCH_SIZE,
      scanLimit: opts.config?.linkScanLimit ?? DEFAULT_LINK_SCAN_LIMIT
    });

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Sleep Cycle Complete 💤`);
    console.log(`  Facts extracted:   ${stats.factsExtracted}`);
    console.log(`  Duplicates merged: ${stats.duplicatesMerged}`);
    console.log(`  Stale/expired:     ${stats.staleArchived} (incl. expired)`);
    console.log(`  Links created:     ${stats.linksCreated}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  } catch (err) {
    console.error("[SLEEP CYCLE] Fatal error during maintenance:", err);
  }

  return stats;
}

// =============================================================================
// BACKGROUND SERVICE — runs on an interval while the gateway is up
// =============================================================================

let _serviceTimer: ReturnType<typeof setInterval> | null = null;

export function startService(opts: SleepCycleOptions & { intervalHours?: number } = {}): void {
  if (_serviceTimer) {
    return;
  }
  const intervalMs = (opts.intervalHours || DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
  const label = `${opts.intervalHours || DEFAULT_INTERVAL_HOURS}h`;

  console.log(`[SLEEP SERVICE] Started — first cycle in ${label}, then every ${label} for all active agents`);

  // Do NOT run immediately — this blocks plugin install/validation.
  // First cycle fires after the interval elapses.
  _serviceTimer = setInterval(async () => {
    console.log(`[SLEEP SERVICE] Interval tick — fetching active agents`);
    try {
      const sql = getSql();
      const agents = await sql`SELECT id FROM agents`;

      for (const agent of agents) {
        console.log(`[SLEEP SERVICE] Starting cycle for agent="${agent.id}"`);
        // Override opts.agentId for each cycle run so it doesn't default to 'main'
        const agentConfig = await loadConfig(agent.id);
        await runSleepCycle({ ...opts, agentId: agent.id, config: agentConfig.sleep }).catch((err) =>
          console.error(`[SLEEP SERVICE] Cycle failed for agent="${agent.id}":`, err)
        );
      }
    } catch (err) {
      console.error("[SLEEP SERVICE] Failed to fetch agents or run cycle:", err);
    }
  }, intervalMs);
}

export function stopService(): void {
  if (_serviceTimer) {
    clearInterval(_serviceTimer);
    _serviceTimer = null;
    console.log(`[SLEEP SERVICE] Stopped`);
  }
}

// =============================================================================
// STANDALONE CLI ENTRY POINT
// =============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  const specificAgentId = getArg("--agent-id") || args.find((a) => !a.startsWith("--"));

  async function runStandalone() {
    try {
      if (specificAgentId) {
        console.log(`[SLEEP SERVICE] Running manual cycle for specific agent="${specificAgentId}"`);
        const agentConfig = await loadConfig(specificAgentId);
        await runSleepCycle({ agentId: specificAgentId, config: agentConfig.sleep });
      } else {
        console.log(`[SLEEP SERVICE] Running manual cycle for all active agents`);
        const sql = getSql();
        const agents = await sql`SELECT id FROM agents`;

        for (const agent of agents) {
          console.log(`[SLEEP SERVICE] Starting cycle for agent="${agent.id}"`);
          const agentConfig = await loadConfig(agent.id);
          await runSleepCycle({ agentId: agent.id, config: agentConfig.sleep }).catch((err) =>
            console.error(`[SLEEP SERVICE] Cycle failed for agent="${agent.id}":`, err)
          );
        }
      }
    } finally {
      getSql().end();
    }
  }

  runStandalone().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("[SLEEP SERVICE] Standalone run failed:", err);
    process.exit(1);
  });
}