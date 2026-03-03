import postgres from "npm:postgres";

const LM_STUDIO_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = Deno.env.get("AGENT_ID") || "openclaw-proto-1";

const sql = postgres(DB_URL);

interface SleepCycleResult {
  session_summary: string;
  extracted_durable_facts: string[];
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LM_STUDIO_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function runSleepCycle() {
  console.log(`[SLEEP CYCLE] Waking up for agent: ${AGENT_ID}...`);

  try {
    // 1. Fetch recent unarchived episodic memories (Wrapped in RLS transaction)
    const episodes = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      return await tx`
        SELECT id, event_type, event_summary, created_at 
        FROM memory_episodic 
        WHERE agent_id = ${AGENT_ID} AND is_archived = false
        ORDER BY created_at ASC
        LIMIT 100;
      `;
    });

    if (episodes.length === 0) {
      console.log(`[SLEEP CYCLE] No new episodic memories to process. Going back to sleep.`);
      process.exit(0);
    }

    console.log(`[SLEEP CYCLE] Found ${episodes.length} episodic events to consolidate.`);

    // 2. Format the events into a chronological transcript
    const transcript = episodes.map((e: any) => `[${e.created_at}] [${e.event_type.toUpperCase()}]: ${e.event_summary}`).join("\n");

    // 3. Ask the LLM to extract durable facts
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

    const res = await fetch(`${LM_STUDIO_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5-9b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Here is the recent episodic transcript to analyze:\n\n${transcript}` }
        ],
        temperature: 0.1,
      }),
    });

    const data = await res.json();
    let jsonString = data.choices[0].message.content.trim();

    // 4. Strip the Reasoning block from the qwen3.5-35b output
    jsonString = jsonString.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (jsonString.startsWith("```json")) jsonString = jsonString.replace(/^```json\n/, "").replace(/\n```$/, "");
    if (jsonString.startsWith("```")) jsonString = jsonString.replace(/^```\n/, "").replace(/\n```$/, "");

    const result: SleepCycleResult = JSON.parse(jsonString);
    console.log(`[SLEEP CYCLE] Synthesis complete. Extracted ${result.extracted_durable_facts.length} permanent facts.`);
    console.log(`[SLEEP CYCLE] Session Summary: ${result.session_summary}`);

    // 5. Store the extracted facts and archive the episodic logs in a single transaction
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      // Insert the durable facts into the semantic memory table
      for (const fact of result.extracted_durable_facts) {
        const embedding = await getEmbedding(fact);
        
        // Generate hash to prevent duplicate facts
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(fact));
        const contentHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        await tx`
          INSERT INTO memory_semantic (
            agent_id, access_scope, content, content_hash, embedding, embedding_model, tier
          ) VALUES (
            ${AGENT_ID}, 'private', ${fact}, ${contentHash}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe', 'permanent'
          ) ON CONFLICT (agent_id, content_hash) DO NOTHING;
        `;
        console.log(`[SLEEP CYCLE] -> Saved durable fact: "${fact}"`);
      }

      // Mark the processed episodic events as archived so we don't process them again
      const episodeIds = episodes.map((e: any) => e.id);
      await tx`
        UPDATE memory_episodic 
        SET is_archived = true 
        WHERE id IN ${sql(episodeIds)}
      `;
    });

    console.log(`[SLEEP CYCLE] Successfully archived ${episodes.length} short-term memories. Sleep cycle complete.`);

  } catch (err) {
    console.error("[SLEEP CYCLE] Fatal error during consolidation:", err);
  } finally {
    await sql.end();
  }
}

runSleepCycle();