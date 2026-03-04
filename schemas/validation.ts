import { z } from "zod";

// =============================================================================
// SHARED ENUMS & PRIMITIVES
// =============================================================================

export const AccessScopeSchema = z.enum(["private", "shared", "global"]);
export const VolatilitySchema = z.enum(["low", "medium", "high"]);
export const MemoryTierSchema = z.enum(["volatile", "session", "daily", "stable", "permanent"]);
export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

// =============================================================================
// MEMORY OPTIONS (single source of truth — replaces the manual interface)
// =============================================================================

export const MemoryOptionsSchema = z.object({
    category: z.string().max(50).optional().nullable(),
    source_uri: z.string().url().max(512).optional().nullable(),
    volatility: VolatilitySchema.optional().nullable(),
    is_pointer: z.boolean().optional().nullable(),
    token_count: z.number().int().optional().nullable(),
    tier: MemoryTierSchema.optional().nullable(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    usefulness_score: z.number().optional().nullable(),
    expires_at: z.date().optional().nullable(),
    metadata: z.record(z.string(), z.any()).optional().nullable(),
});

export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>;

export const StoreMemoryInputSchema = z.object({
    content: z.string().min(1),
    scope: AccessScopeSchema.default("private"),
    options: MemoryOptionsSchema.optional(),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInputSchema>;

export const UpdateMemoryInputSchema = z.object({
    oldMemoryId: z.string().uuid(),
    newFact: z.string().min(1),
    options: MemoryOptionsSchema.optional(),
});

export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>;

// =============================================================================
// DATABASE ROW SHAPES — typed results from postgres queries
// =============================================================================

export const SearchResultRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    similarity: z.number(),
    relationship_type: z.string().nullable().optional(),
});

export type SearchResultRow = z.infer<typeof SearchResultRowSchema>;

export const EpisodicRowSchema = z.object({
    id: z.string().uuid(),
    event_type: z.string(),
    event_summary: z.string(),
    created_at: z.coerce.date(),
});

export type EpisodicRow = z.infer<typeof EpisodicRowSchema>;

export const PersonaRowSchema = z.object({
    category: z.string(),
    content: z.string(),
    relevance_score: z.number(),
});

export type PersonaRow = z.infer<typeof PersonaRowSchema>;

export const MemorySemanticRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    embedding: z.any(),
    usefulness_score: z.number().nullable().optional(),
    access_count: z.number().nullable().optional(),
    created_at: z.coerce.date().optional(),
});

export type MemorySemanticRow = z.infer<typeof MemorySemanticRowSchema>;

export const DuplicateCandidateRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    usefulness_score: z.number().nullable().optional(),
    access_count: z.number().nullable().optional(),
});

export type DuplicateCandidateRow = z.infer<typeof DuplicateCandidateRowSchema>;

export const StaleMemoryRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    tier: z.string(),
    access_count: z.number(),
    created_at: z.coerce.date(),
});

export type StaleMemoryRow = z.infer<typeof StaleMemoryRowSchema>;

export const LinkCandidateRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    similarity: z.number(),
});

export type LinkCandidateRow = z.infer<typeof LinkCandidateRowSchema>;

/** OpenAI-compatible tool definition (function calling format). */
export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// =============================================================================
// LLM / API RESPONSE SCHEMAS
// =============================================================================

export const EmbeddingDataSchema = z.object({
    embedding: z.array(z.number()),
});

export const EmbeddingApiResponseSchema = z.object({
    data: z.array(EmbeddingDataSchema).min(1),
});

export type EmbeddingApiResponse = z.infer<typeof EmbeddingApiResponseSchema>;

export const OpenClawAgentResponseSchema = z.object({
    status: z.string(),
    summary: z.string().optional(),
    result: z.object({
        payloads: z.array(z.object({
            text: z.string(),
        })),
    }).optional(),
});

export type OpenClawAgentResponse = z.infer<typeof OpenClawAgentResponseSchema>;

/** LLM output from sleep_cycle Phase 1: episodic consolidation */
export const SleepCycleResultSchema = z.object({
    session_summary: z.string(),
    extracted_durable_facts: z.array(z.string()),
});

export type SleepCycleResult = z.infer<typeof SleepCycleResultSchema>;

/** LLM output from sleep_cycle Phase 4: link classification */
export const LinkClassificationSchema = z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
});

export type LinkClassification = z.infer<typeof LinkClassificationSchema>;

/** LLM output from bootstrap_persona.ts */
export const PersonaChunkSchema = z.object({
    category: z.string(),
    content: z.string(),
    is_always_active: z.boolean(),
});

export type PersonaChunk = z.infer<typeof PersonaChunkSchema>;

// =============================================================================
// OPENCLAW PLUGIN HOOK EVENT / CONTEXT TYPES
// =============================================================================

export const ContentPartSchema = z.object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional(),
});

export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ToolCallRecordSchema = z.object({
    id: z.string().optional(),
    type: z.literal("function").optional(),
    function: z.object({
        name: z.string(),
        arguments: z.string(),
    }),
});

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const ChatMessageSchema = z.object({
    role: ChatRoleSchema,
    content: z.union([z.string(), z.array(ContentPartSchema), z.null()]),
    tool_calls: z.array(ToolCallRecordSchema).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Event payload for the before_prompt_build hook */
export interface PromptBuildEvent {
    prompt?: string;
    messages?: ChatMessage[];
}

/** Context for the before_prompt_build hook */
export interface PromptBuildCtx {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
}

/** Event payload for the agent_end hook */
export interface AgentEndEvent {
    messages?: ChatMessage[];
    success: boolean;
    error?: string;
    durationMs: number;
}

/** Context for the agent_end hook */
export interface AgentEndCtx {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
}

/** Event payload for the message_received hook */
export interface MessageReceivedEvent {
    from?: string;
    content?: string;
    channelId?: string;
}

// =============================================================================
// TOOL ARGUMENT SCHEMAS (for runtime validation in execute handlers)
// =============================================================================

export const MemoryStoreArgsSchema = z.object({
    content: z.string(),
    scope: AccessScopeSchema.optional().default("private"),
    category: z.string().optional(),
    volatility: VolatilitySchema.optional(),
    tier: MemoryTierSchema.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type MemoryStoreArgs = z.infer<typeof MemoryStoreArgsSchema>;

export const MemoryUpdateArgsSchema = z.object({
    old_memory_id: z.string(),
    new_fact: z.string(),
    category: z.string().optional(),
    volatility: VolatilitySchema.optional(),
    tier: MemoryTierSchema.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type MemoryUpdateArgs = z.infer<typeof MemoryUpdateArgsSchema>;

export const MemoryLinkArgsSchema = z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
});

export type MemoryLinkArgs = z.infer<typeof MemoryLinkArgsSchema>;

export const ToolStoreArgsSchema = z.object({
    tool_name: z.string(),
    tool_json: z.string(),
    scope: AccessScopeSchema.optional().default("private"),
});

export type ToolStoreArgs = z.infer<typeof ToolStoreArgsSchema>;

// =============================================================================
// BOOTSTRAP TOOLS SCHEMA
// =============================================================================

export const ToolFunctionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
});

export const ToolDefinitionSchema = z.object({
    type: z.literal("function").optional(),
    function: ToolFunctionSchema,
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const PromptJsonSchema = z.object({
    tools: z.array(ToolDefinitionSchema),
});

export type PromptJson = z.infer<typeof PromptJsonSchema>;
