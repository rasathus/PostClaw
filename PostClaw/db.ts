import postgres from "postgres";
import { createHash } from "node:crypto";
import "dotenv/config";

// =============================================================================
// CONFIG
// =============================================================================

export const LM_STUDIO_URL = process.env.LM_STUDIO_URL;
export const DB_URL = process.env.DB_URL;
export const AGENT_ID = process.env.AGENT_ID;
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

if (!LM_STUDIO_URL || !DB_URL || !AGENT_ID) {
  throw new Error("Missing required environment variables. Please check your .env file.");
}

// =============================================================================
// DATABASE CLIENT
// =============================================================================

export const sql = postgres(DB_URL);

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Generate a vector embedding for a given text string via LM Studio.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error(`[EMBED] Refusing to embed empty/undefined text (received: ${JSON.stringify(text)})`);
  }

  const body = JSON.stringify({ input: text, model: EMBEDDING_MODEL });
  console.log(`[EMBED] Request body preview: ${body.substring(0, 200)}`);

  const res = await fetch(`${LM_STUDIO_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  const embedding: number[] = data.data[0].embedding;

  console.log(`[EMBED] Generated ${embedding.length}-dim vector for: "${text.substring(0, 50)}..."`);
  return embedding;
}

/**
 * SHA-256 content hash for deduplication.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
