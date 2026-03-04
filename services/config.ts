import { getSql } from "./db.js";

// =============================================================================
// CONFIG INTERFACE
// =============================================================================

export interface PostClawConfig {
  rag: {
    semanticLimit: number;
    linkedSimilarity: number;
    totalLimit: number;
  };
  persona: {
    situationalLimit: number;
  };
  sleep: {
    episodicBatchLimit: number;
    duplicateSimilarityThreshold: number;
    duplicateScanLimit: number;
    lowValueAgeDays: number;
    lowValueProtectedTiers: string[];
    linkSimilarityMin: number;
    linkSimilarityMax: number;
    linkCandidatesPerMemory: number;
    linkBatchSize: number;
    linkScanLimit: number;
  };
  dedup: {
    maxCacheSize: number;
  };
  prompts: Record<string, string>;
}

// =============================================================================
// DEFAULTS
// =============================================================================

export const DEFAULT_CONFIG: PostClawConfig = {
  rag: {
    semanticLimit: 7,
    linkedSimilarity: 0.8,
    totalLimit: 15,
  },
  persona: {
    situationalLimit: 3,
  },
  sleep: {
    episodicBatchLimit: 100,
    duplicateSimilarityThreshold: 0.80,
    duplicateScanLimit: 200,
    lowValueAgeDays: 7,
    lowValueProtectedTiers: ['permanent', 'stable'],
    linkSimilarityMin: 0.65,
    linkSimilarityMax: 0.92,
    linkCandidatesPerMemory: 5,
    linkBatchSize: 20,
    linkScanLimit: 50,
  },
  dedup: {
    maxCacheSize: 1000,
  },
  prompts: {
    memoryRules: `## Memory & Knowledge Management
You are a stateful agent. Your context window is ephemeral but your PostgreSQL memory is permanent.
Silently manage your knowledge — never ask permission to save, link, or update facts.

- **Retrieval:** Relevant memories (with UUID tags) are auto-injected.
- **Search:** Use the \`memory_search\` tool when you need to recall facts not in the current context.
- **Correct/update facts:** Use the \`memory_update\` tool when a fact is incorrect, outdated, or needs to be updated. When using memory_update, ALWAYS assign an appropriate 'tier' and 'category'.
- **Save new facts:** Use the \`memory_store\` tool when a new fact is learned. When using memory_store, ALWAYS assign an appropriate 'tier' (e.g., 'permanent' for core user identity, 'daily' for current tasks) and 'category'.
- **Link related memories:** Use the \`memory_link\` tool when two memories are related.`,
    personaRules: `## Persona Management
You have access to the following tools to manage your persona/identity/rules:

- **Retrieval**: Use \`persona_list\` to see all available persona rules or \`persona_get\` for details.
- **Creation**: Use \`persona_create\` to define a new set of rules or identity markers.
- **Modification**: Use \`persona_update\` to modify an existing persona rule.
- **Deletion**: Use \`persona_delete\` to remove a persona rule.`,
    heartbeatRules: `## Autonomous Heartbeats
OpenClaw provides a native heartbeat loop — never use Linux crontab.
To schedule background tasks, add a checklist to: {{heartbeatFilePath}}
On heartbeat poll: read that file. If no pending tasks, reply with ONLY: HEARTBEAT_OK

**Always Reply**: ALWAYS conclude your turn with a direct response to the user.`,
    heartbeatFilePath: "/home/cl/.openclaw/workspace/HEARTBEAT.md",
  }
};

// =============================================================================
// PERSISTENCE
// =============================================================================

let _runtimeConfig: Record<string, PostClawConfig> = {};

export async function loadConfig(agentId: string = "main"): Promise<PostClawConfig> {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT config_key, config_value 
      FROM plugin_config 
      WHERE agent_id = ${agentId}
    `;

    // Start with a clean deep copy of defaults to prevent mutating the global DEFAULT_CONFIG
    const merged: PostClawConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    for (const row of rows) {
      const key = row.config_key as keyof PostClawConfig;
      if (key in merged) {
        if (key === "prompts") {
          // completely overwrite prompts with what is in DB allows dynamically removing prompts
          merged[key] = row.config_value;
        } else {
          merged[key] = { 
            ...(merged[key] as object), 
            ...(row.config_value as object) 
          } as any;
        }
      }
    }

    _runtimeConfig[agentId] = merged;
    return merged;
  } catch (err) {
    console.warn(`[PostClaw] Failed to load config from DB for agent ${agentId}:`, err);
    // If DB fails (like during setup), fallback to defaults
    _runtimeConfig[agentId] = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return _runtimeConfig[agentId];
  }
}

export async function saveConfig(agentId: string, config: PostClawConfig): Promise<void> {
  try {
    const sql = getSql();
    
    // Upsert each main section as a JSONB value
    await sql.begin(async (tx: any) => {
      for (const [key, value] of Object.entries(config)) {
        await tx`
          INSERT INTO plugin_config (agent_id, config_key, config_value)
          VALUES (${agentId}, ${key}, ${value as any})
          ON CONFLICT (agent_id, config_key) 
          DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = CURRENT_TIMESTAMP
        `;
      }
    });

    _runtimeConfig[agentId] = { ...config };
    console.log(`[PostClaw] Config saved to database for agent ${agentId}`);
  } catch (err) {
    console.error(`[PostClaw] Failed to save config to database for agent ${agentId}:`, err);
    throw err;
  }
}

export function getCurrentConfig(agentId: string = "main"): PostClawConfig {
  return _runtimeConfig[agentId] || DEFAULT_CONFIG;
}
