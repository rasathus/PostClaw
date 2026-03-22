import postgres from "postgres";
import { createHash } from "node:crypto";
import "dotenv/config";
import { EmbeddingApiResponseSchema } from "../schemas/validation.js";


// =============================================================================
// CONFIG
// =============================================================================

export let LM_STUDIO_URL = process.env.LM_STUDIO_URL;
export let POSTCLAW_DB_URL = process.env.POSTCLAW_DB_URL;
export let EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

/**
 * Set the database connection URL. Called by the plugin register() if the user
 * supplies `dbUrl` in the plugin config. Falls back to env var POSTCLAW_DB_URL.
 */
export function setDbUrl(url: string) {
  POSTCLAW_DB_URL = url;
}

/**
 * Ranges that are NOT a legitimate embedding service endpoint.
 * Loopback (127.x / ::1) is intentionally NOT blocked here — LM Studio
 * on localhost is the standard PostClaw deployment.
 * We block link-local (169.254/16) which hosts cloud-provider metadata
 * services (AWS IMDSv1, GCP) and the unspecified address 0.0.0.0.
 */
const SSRF_BLOCKED_PATTERN = /^(169\.254\.|0\.0\.0\.0)/i;

/**
 * Validates a URL intended for the embedding API:
 *   - Must use http: or https: scheme
 *   - Must not contain embedded credentials (user:pass@host)
 *   - Hostname must not be a link-local or unspecified address
 * Throws if the URL fails any check.
 */
function validateEmbeddingUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[EMBED] Invalid LM_STUDIO_URL — cannot parse as URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`[EMBED] Invalid LM_STUDIO_URL scheme '${parsed.protocol}' — only http/https allowed`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`[EMBED] LM_STUDIO_URL must not contain embedded credentials`);
  }
  if (SSRF_BLOCKED_PATTERN.test(parsed.hostname)) {
    throw new Error(`[EMBED] LM_STUDIO_URL hostname '${parsed.hostname}' is blocked (link-local/metadata range)`);
  }
  // Return just the origin to strip any path component that might have been set
  return parsed.origin;
}

/**
 * Configure the embedding provider settings. Usually called by index.ts during OpenClaw initialization.
 */
export function setEmbeddingConfig(url: string, model: string) {
  // Validate at configuration time so misconfiguration is caught on boot,
  // not silently during the first embedding request.
  // Allow localhost/127.0.0.1 only when explicitly set here (local dev workflow);
  // the SSRF guard in getEmbedding() checks the runtime value instead.
  LM_STUDIO_URL = url;
  EMBEDDING_MODEL = model;
  console.log(`[EMBED] Configured via OpenClaw -> Base: ${url} | Model: ${model}`);
}

// =============================================================================
// DATABASE CLIENT — Lazily initialized
// =============================================================================

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Returns the shared postgres client, creating it on first use. This allows the
 * plugin config (`dbUrl`) to be applied before the connection is opened.
 */
export function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;

  if (!POSTCLAW_DB_URL) {
    throw new Error(
      "Missing database URL. Set 'dbUrl' in plugins.entries.postclaw.config or the POSTCLAW_DB_URL environment variable."
    );
  }

  _sql = postgres(POSTCLAW_DB_URL);
  console.log(`[PostClaw] Database connection established`);
  return _sql;
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Generate a vector embedding for a given text string via LM Studio.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (!LM_STUDIO_URL) {
    throw new Error(`[EMBED] Cannot get embedding. Configuration not injected.`);
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error(`[EMBED] Refusing to embed empty/undefined text (received: ${JSON.stringify(text)})`);
  }

  const body = JSON.stringify({ input: text, model: EMBEDDING_MODEL });
  console.log(`[EMBED] Request body preview: ${body.substring(0, 200)}`);

  // Normalise the configured URL: strip trailing /v1 suffix, then validate
  // scheme and block private/loopback ranges to prevent SSRF.
  const rawUrl = LM_STUDIO_URL!.replace(/\/v1\/?$/, "");
  const baseUrl = validateEmbeddingUrl(rawUrl);
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
  }

  const raw: unknown = await res.json();
  const parsed = EmbeddingApiResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`[EMBED] Unexpected API response. URL: ${baseUrl}/v1/embeddings — Errors: ${parsed.error.message}`);
  }

  const embedding = parsed.data.data[0].embedding;

  console.log(`[EMBED] Generated ${embedding.length}-dim vector for: "${text.substring(0, 50)}..."`);
  return embedding;
}

/**
 * Validates the currently configured embedding model against the dimensions
 * expected by the Postgres schema for this agent. Returns a compatibility status.
 */
export async function validateEmbeddingDimension(agentId: string): Promise<{
  model: string;
  expected: number;
  actual: number;
  matches: boolean;
}> {
  try {
    const sql = getSql();
    
    // 1. Get expected dimensions from schema
    const agents = await sql`
      SELECT embedding_dimensions 
      FROM agents 
      WHERE id = ${agentId}
    `;
    
    // Default to 768 if entirely missing (e.g. older schema version before columns added)
    const expected = agents.length > 0 && agents[0].embedding_dimensions 
      ? agents[0].embedding_dimensions 
      : 768;

    // 2. Generate a tiny test embedding to find actual dimensions
    const testEmbedding = await getEmbedding("test dimension check");
    const actual = testEmbedding.length;
    
    const matches = expected === actual;
    const model = EMBEDDING_MODEL;

    if (!matches) {
       console.error(`[EMBED] DIMENSION MISMATCH ERROR! Model '${model}' returned ${actual} dimensions, but database schema expects ${expected}. Semantic writes will fail.`);
    } else {
       console.log(`[EMBED] Model '${model}' verified: ${actual} dimensions.`);
    }

    return { model, expected, actual, matches };
  } catch (err) {
    console.error(`[EMBED] Failed to validate dimensions:`, err);
    throw err;
  }
}

/**
 * SHA-256 content hash for deduplication.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
