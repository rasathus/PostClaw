import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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
  dynamicTools: {
    similarityThreshold: number;
    maxTools: number;
  };
  dedup: {
    maxCacheSize: number;
  };
  prompts: {
    memoryRules: string;
    personaRules: string;
    heartbeatRules: string;
    heartbeatFilePath: string;
  };
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
  dynamicTools: {
    similarityThreshold: 0.35,
    maxTools: 3,
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
- **Link related memories:** Use the \`memory_link\` tool when two memories are related.
- **Store a tool:** Use the \`tool_store\` tool when a new tool schema is learned.
- **Always Reply**: ALWAYS conclude your turn with a direct response to the user.`,
    personaRules: `## Persona Management
You have access to the following tools to manage your persona/identity/rules:

- **Retrieval**: Use \`persona_list\` to see all available persona rules or \`persona_get\` for details.
- **Creation**: Use \`persona_create\` to define a new set of rules or identity markers.
- **Modification**: Use \`persona_update\` to modify an existing persona rule.
- **Deletion**: Use \`persona_delete\` to remove a persona rule.`,
    heartbeatRules: `## Autonomous Heartbeats
OpenClaw provides a native heartbeat loop — never use Linux crontab.
To schedule background tasks, add a checklist to: {{heartbeatFilePath}}
On heartbeat poll: read that file. If no pending tasks, reply with ONLY: HEARTBEAT_OK`,
    heartbeatFilePath: "~/.openclaw/workspace/HEARTBEAT.md",
  }
};

// =============================================================================
// PERSISTENCE
// =============================================================================

let _workspaceDir: string | null = null;
let _runtimeConfig: PostClawConfig = { ...DEFAULT_CONFIG };

export function setWorkspaceDir(dir: string) {
  _workspaceDir = dir;
}

export async function loadConfig(): Promise<PostClawConfig> {
  if (!_workspaceDir) return DEFAULT_CONFIG;

  const configPath = join(_workspaceDir, "postclaw.config.json");
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = await readFile(configPath, "utf-8");
    const loaded = JSON.parse(raw);
    // Deep merge or just overwrite for now
    _runtimeConfig = { 
      ...DEFAULT_CONFIG, 
      ...loaded,
      rag: { ...DEFAULT_CONFIG.rag, ...loaded.rag },
      persona: { ...DEFAULT_CONFIG.persona, ...loaded.persona },
      sleep: { ...DEFAULT_CONFIG.sleep, ...loaded.sleep },
      dynamicTools: { ...DEFAULT_CONFIG.dynamicTools, ...loaded.dynamicTools },
      dedup: { ...DEFAULT_CONFIG.dedup, ...loaded.dedup },
      prompts: { ...DEFAULT_CONFIG.prompts, ...loaded.prompts },
    };
    return _runtimeConfig;
  } catch (err) {
    console.error(`[PostClaw] Failed to load config from ${configPath}:`, err);
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: PostClawConfig): Promise<void> {
  if (!_workspaceDir) {
    console.warn("[PostClaw] Cannot save config: no workspace directory set");
    return;
  }

  const configPath = join(_workspaceDir, "postclaw.config.json");
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    _runtimeConfig = { ...config };
    console.log(`[PostClaw] Config saved to ${configPath}`);
  } catch (err) {
    console.error(`[PostClaw] Failed to save config to ${configPath}:`, err);
  }
}

export function getCurrentConfig(): PostClawConfig {
  return _runtimeConfig;
}
