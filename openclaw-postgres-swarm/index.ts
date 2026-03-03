// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { sql, LM_STUDIO_URL, DB_URL, AGENT_ID, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";
export { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";
export type { ChatCompletionTool } from "./memoryService.js";

// =============================================================================
// TYPES
// =============================================================================

import type { ChatCompletionTool } from "./memoryService.js";

/** A single message in the OpenAI chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  name?: string;
}

/** Multimodal content part (text, image, etc). */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/** A tool call record attached to an assistant message. */
export interface ToolCallRecord {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// =============================================================================
// IN-MEMORY DEDUPLICATION
// =============================================================================

const processedEvents = new Set<string>();
const MAX_CACHE_SIZE = 1000;

function isDuplicate(key: string): boolean {
  if (processedEvents.has(key)) return true;
  processedEvents.add(key);
  if (processedEvents.size > MAX_CACHE_SIZE) processedEvents.clear();
  return false;
}

// =============================================================================
// HELPERS
// =============================================================================

import { getEmbedding } from "./db.js";
import { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";
import * as fs from "node:fs";
import * as path from "node:path";

// const DEBUG_LOG_DIR = path.join(__dirname, "..", "debug_logs");

// function debugLog(hookName: string, suffix: string, data: any): void {
//   try {
//     if (!fs.existsSync(DEBUG_LOG_DIR)) fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
//     const ts = new Date().toISOString().replace(/[:.]/g, "-");
//     const filename = `${hookName}_${ts}_${suffix}.json`;
//     const content = JSON.stringify(data, null, 2);
//     fs.writeFileSync(path.join(DEBUG_LOG_DIR, filename), content);
//     console.log(`[openclaw-postgres] 📄 Debug log: ${filename} (${content.length} bytes)`);
//   } catch (err) {
//     console.error(`[openclaw-postgres] Failed to write debug log:`, err);
//   }
// }

/**
 * Extracts the text content from the last user message in a messages array.
 */
function extractUserText(messages: ChatMessage[]): string {
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIndex === -1) return "";

  const content = messages[lastUserIndex].content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join(" ");
  }
  return "";
}

// =============================================================================
// OPENCLAW PLUGIN — Default export for plugin loader
// =============================================================================

const openclawPostgresPlugin = {
  id: "openclaw-postgres",
  name: "OpenClaw Postgres Swarm",
  description: "PostgreSQL-backed RAG, memory, and persona management",

  register(api: any) {
    console.log("[openclaw-postgres] Registering plugin hooks...");

    // -------------------------------------------------------------------------
    // before_prompt_build — Prune + replace system prompt, inject RAG context
    //
    // This is a MODIFYING hook. The handler receives:
    //   event = { prompt: string, messages: ChatMessage[] }
    //   ctx   = { agentId, sessionKey, sessionId, workspaceDir }
    //
    // Must RETURN: { systemPrompt?: string, prependContext?: string }
    //   - systemPrompt:   REPLACES the system prompt entirely
    //   - prependContext:  text prepended to the user's message context
    //
    // This replicates the old rag_proxy.ts + payload_pruner.ts pattern:
    // 1. Strip OpenClaw's default bloat sections
    // 2. Inject custom memory architecture rules
    // 3. Append persona from Postgres
    // 4. Inject RAG context as prependContext
    // -------------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (event: any, ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("before_prompt_build", "IN", {
          //   hasPrompt: typeof event.prompt === "string",
          //   promptLength: event.prompt?.length ?? 0,
          //   promptPreview: event.prompt?.substring(0, 500) ?? null,
          //   messageCount: event.messages?.length ?? 0,
          //   messageRoles: (event.messages ?? []).map((m: any) => m.role),
          //   ctx,
          //   eventKeys: Object.keys(event),
          // });

          const messages: ChatMessage[] = event.messages ?? [];
          const userText = extractUserText(messages);
          const cleanText = userText.replace(/^\[.*?\]\s*/, "");
          const isHeartbeat = cleanText.toLowerCase().includes("heartbeat") || cleanText.toLowerCase().includes("cron");

          console.log(`[openclaw-postgres] before_prompt_build: "${cleanText.substring(0, 80)}..." (heartbeat=${isHeartbeat})`);

          // ==================================================================
          // STEP 1: Prune the system prompt (strip OpenClaw default bloat)
          // ==================================================================
          let sysPrompt: string = event.prompt ?? "";

          // Strip default Tooling, Safety, and Skills rules
          sysPrompt = sysPrompt.replace(/## Tooling[\s\S]*?(?=## Workspace)/g, "");

          // Strip default Documentation and Time rules
          sysPrompt = sysPrompt.replace(/## Documentation[\s\S]*?(?=## Inbound Context)/g, "");

          // Strip the ENTIRE Project Context (all injected Markdown files)
          sysPrompt = sysPrompt.replace(/# Project Context[\s\S]*?(?=## Silent Replies)/g, "");

          // Conditionally strip Heartbeats section (keep it for heartbeat messages)
          if (!isHeartbeat) {
            sysPrompt = sysPrompt.replace(/## Heartbeats[\s\S]*?(?=## Runtime)/g, "");
          }

          // Clean up excess whitespace
          sysPrompt = sysPrompt.replace(/\n{3,}/g, "\n\n");

          // ==================================================================
          // STEP 2: Inject custom memory architecture rules
          // ==================================================================
          const agentId = AGENT_ID;

          sysPrompt += `
## Autonomous Cognitive Architecture
You are a stateful, proactive agent. Your context window is ephemeral, but your PostgreSQL memory is permanent.
CRITICAL DIRECTIVE: You must actively and silently manage your own knowledge base. Do NOT ask the user for permission to save, link, or update facts. If you learn something, act on it immediately using your \`exec\` tool.

1. **AUTOMATIC RETRIEVAL:** Relevant past memories (with UUID tags) are automatically injected into your prompt. Do not attempt to search for them.
2. **PROACTIVE LEARNING:** If the user reveals a new preference, project detail, or durable fact, you MUST permanently save it:
   deno run -A /home/cl/.openclaw/workspace/skills/db-memory-store/script.ts "${agentId}" "global" "<exact_text_to_remember>"
3. **GRAPH LINKING:** If a newly learned fact relates to an older memory ID currently in your context, explicitly connect them:
   deno run -A /home/cl/.openclaw/workspace/skills/db-memory-link/script.ts "<source_id>" "<target_id>" "<relationship>"
4. **MEMORY CORRECTION:** If the user corrects you, or a fact changes, you MUST deprecate the old memory ID and establish the new truth:
   deno run -A /home/cl/.openclaw/workspace/skills/db-memory-update/script.ts "<old_memory_id>" "<new_corrected_fact>"
`;

          sysPrompt += `
## Deno Location
Deno is installed at: /home/cl/.deno/bin/deno
`;

          sysPrompt += `
## Sleep Cycle
You are equipped with a sleep cycle that consolidates your short-term memory into durable facts.
When you receive a user prompt, you should proactively run the sleep cycle to extract durable facts.

To run the sleep cycle, use your \`exec\` tool to run this exact command:
deno run --allow-net --allow-env /home/cl/.openclaw/workspace/scripts/sleep_cycle.ts "${agentId}"
`;

          sysPrompt += `
## Autonomous Heartbeats
OpenClaw provides a native background heartbeat loop. NEVER use Linux crontab.
To schedule future work or background tasks, use your file tools to add a checklist to: /home/cl/.openclaw/workspace/HEARTBEAT.md
When you receive a heartbeat poll, read that file. If you have no pending tasks, reply with ONLY: HEARTBEAT_OK
`;

          sysPrompt += `
## Tool Store
You are equipped with a tool store that allows you to store and retrieve tools for later use.
To store a tool, use your \`exec\` tool to run this exact command:
deno run --allow-net --allow-env /home/cl/.openclaw/workspace/skills/db-tool-store/script.ts "${agentId}" "<private|global>" "<tool_name>" "<tool_json>"
`;

          // ==================================================================
          // STEP 3: Fetch persona + RAG context from Postgres (in parallel)
          // ==================================================================
          const result: { systemPrompt?: string; prependContext?: string } = {};

          if (cleanText.trim()) {
            const embedding = await getEmbedding(cleanText);

            const [memoryContext, personaContext] = await Promise.all([
              searchPostgres(cleanText),
              fetchPersonaContext(embedding),
            ]);

            // Persona context → append to the pruned system prompt
            if (personaContext) {
              sysPrompt += `\n\n## Dynamic Database Persona\nThe following core operational rules were loaded from your database:\n${personaContext}\n`;
              console.log(`[openclaw-postgres] 🎭 Injected persona context`);
            }

            // RAG context → prependContext (injected before the user message)
            if (memoryContext) {
              result.prependContext =
                `[SYSTEM RAG CONTEXT]\n` +
                `The following historical memories were retrieved from the database. ` +
                `Use them to help answer the user's query if they are relevant:\n\n` +
                `${memoryContext}\n\n` +
                `[END CONTEXT]`;
              console.log(`[openclaw-postgres] 📚 Injected RAG context (${memoryContext.split("\n").length} lines)`);
            }
          }

          // Return the fully replaced system prompt
          result.systemPrompt = sysPrompt;
          console.log(`[openclaw-postgres] ✅ System prompt replaced (${sysPrompt.length} chars)`);

          // --- DEBUG: dump outgoing result ---
          // debugLog("before_prompt_build", "OUT", {
          //   systemPromptLength: result.systemPrompt?.length ?? 0,
          //   systemPromptPreview: result.systemPrompt?.substring(0, 500) ?? null,
          //   prependContextLength: result.prependContext?.length ?? 0,
          //   prependContextPreview: result.prependContext?.substring(0, 500) ?? null,
          //   fullSystemPrompt: result.systemPrompt,
          //   fullPrependContext: result.prependContext,
          // });

          return result;
        } catch (err) {
          console.error("[openclaw-postgres] before_prompt_build error:", err);
        }
      },
      {
        name: "openclaw-postgres.before-prompt-build",
        description: "Prunes default system prompt and injects memory architecture, persona, and RAG context",
      },
    );

    // -------------------------------------------------------------------------
    // JIT Dynamic Tools — registered via api.registerTool()
    //
    // Unlike before_prompt_build, tools are registered with a factory function
    // that resolves dynamically per agent invocation.
    // -------------------------------------------------------------------------
    api.registerTool(
      (toolCtx: any) => {
        // This factory runs each time the agent needs tools.
        // We can't do async here, so we return a wrapper tool that does the
        // actual dynamic lookup. The dynamic tools table holds tool definitions
        // that get injected when semantically relevant.
        //
        // For now, return null — dynamic tool injection will be handled
        // via prependContext instructions to the model.
        return null;
      },
      { names: [] },
    );

    // -------------------------------------------------------------------------
    // agent_end — Log episodic memories after agent completes
    //
    // This is a VOID hook (fire-and-forget). The handler receives:
    //   event = { messages: ChatMessage[], success: boolean, error?: string, durationMs: number }
    //   ctx   = { agentId, sessionKey, sessionId, workspaceDir, messageProvider }
    // -------------------------------------------------------------------------
    api.on(
      "agent_end",
      async (event: any, ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("agent_end", "IN", {
          //   eventKeys: Object.keys(event),
          //   messageCount: event.messages?.length ?? 0,
          //   messageRoles: (event.messages ?? []).map((m: any) => m.role),
          //   success: event.success,
          //   error: event.error,
          //   durationMs: event.durationMs,
          //   ctx,
          // });

          const messages: ChatMessage[] = event.messages ?? [];
          console.log(`[openclaw-postgres] agent_end: ${messages.length} messages, success=${event.success}`);

          // Extract the last user message
          const lastUser = [...messages].reverse().find((m: ChatMessage) => m.role === "user");
          const userMessage = lastUser
            ? typeof lastUser.content === "string"
              ? lastUser.content
              : Array.isArray(lastUser.content)
                ? lastUser.content.filter((p: ContentPart) => p.type === "text").map((p: ContentPart) => p.text).join(" ")
                : ""
            : "";

          const promises: Promise<void>[] = [];

          // Log user message as episodic event
          if (userMessage.trim()) {
            const text = userMessage.replace(/^\[.*?\]\s*/, "");
            if (!isDuplicate(text)) {
              promises.push(
                (async () => {
                  try {
                    const embedding = await getEmbedding(text);
                    await logEpisodicMemory(text, embedding, "user_prompt");
                  } catch (err) {
                    console.error("[openclaw-postgres] Failed to log episodic memory:", err);
                  }
                })()
              );
            }
          }

          // Log tool calls as episodic events
          const toolCalls: ToolCallRecord[] = messages
            .filter((m: ChatMessage) => m.role === "assistant" && m.tool_calls)
            .flatMap((m: ChatMessage) => m.tool_calls ?? []);

          for (const toolCall of toolCalls) {
            const toolCallId = toolCall.id
              || `fallback-${toolCall.function.name}-${toolCall.function.arguments.substring(0, 20)}`;
            if (isDuplicate(toolCallId)) continue;

            promises.push(
              (async () => {
                try {
                  const summary = `Agent executed tool: ${toolCall.function.name} with arguments: ${toolCall.function.arguments}`;
                  const embedding = await getEmbedding(summary);
                  await logEpisodicToolCall(
                    toolCallId,
                    toolCall.function.name,
                    toolCall.function.arguments,
                    embedding
                  );
                } catch (err) {
                  console.error(`[openclaw-postgres] Failed to log tool call (${toolCall.function.name}):`, err);
                }
              })()
            );
          }

          if (promises.length > 0) {
            await Promise.allSettled(promises);
            console.log(`[openclaw-postgres] Episodic logging complete (${promises.length} event(s))`);
          }
        } catch (err) {
          console.error("[openclaw-postgres] agent_end error:", err);
        }
      },
      {
        name: "openclaw-postgres.agent-end",
        description: "Logs episodic memories for user prompts and tool calls after agent completes",
      },
    );

    // -------------------------------------------------------------------------
    // message_received — Log inbound messages to episodic memory
    //
    // This is a VOID hook. The handler receives:
    //   event = { from, content, channelId, ... }  (raw message event fields)
    //   ctx   = { agentId, sessionKey, ... }
    // -------------------------------------------------------------------------
    api.on(
      "message_received",
      async (event: any, _ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("message_received", "IN", {
          //   eventKeys: Object.keys(event),
          //   content: event.content,
          //   from: event.from,
          //   channelId: event.channelId,
          //   _ctx,
          // });

          const content = event.content;
          if (!content || typeof content !== "string" || !content.trim()) return;

          const cleanText = content.replace(/^\[.*?\]\s*/, "");
          if (isDuplicate(cleanText)) return;

          const embedding = await getEmbedding(cleanText);
          await logEpisodicMemory(cleanText, embedding, "inbound_message");
          console.log("[openclaw-postgres] Logged inbound message to episodic memory");
        } catch (err) {
          console.error("[openclaw-postgres] message_received error:", err);
        }
      },
      {
        name: "openclaw-postgres.message-received",
        description: "Logs inbound messages to episodic memory",
      },
    );

    console.log("[openclaw-postgres] Plugin hooks registered successfully");
  },
};

export default openclawPostgresPlugin;

// =============================================================================
// STANDALONE ENTRY POINT (for testing)
// =============================================================================

import { sql, DB_URL, LM_STUDIO_URL, AGENT_ID, EMBEDDING_MODEL } from "./db.js";

if (require.main === module) {
  console.log("=== openclaw-postgres-swarm plugin loaded ===");
  console.log(`  DB:     ${DB_URL}`);
  console.log(`  LM:     ${LM_STUDIO_URL}`);
  console.log(`  Agent:  ${AGENT_ID}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log("Hooks: before_prompt_build, agent_end, message_received");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await sql.end();
    process.exit(0);
  });
}
