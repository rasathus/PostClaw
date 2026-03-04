import { readFile } from "fs/promises";
import { getSql, getEmbedding } from "../services/db.js";
import { PromptJsonSchema, type ToolDefinition } from "../schemas/validation.js";

const sql = getSql();
const AGENT_ID = process.env.AGENT_ID || "default_agent";

// The tools we ALWAYS want in the payload (handled by the pruner)
const CORE_TOOLS = ["read", "write", "edit", "exec", "process", "session_status"];

async function bootstrapTools(promptFilePath: string) {
  try {
    const promptRaw = await readFile(promptFilePath, "utf-8");
    const promptJson = PromptJsonSchema.parse(JSON.parse(promptRaw));
    const tools: ToolDefinition[] = promptJson.tools;
    console.log(`[BOOTSTRAP] Found ${tools.length} tool(s) in prompt.json`);

    // Filter out the core tools, we only want to store the heavy/situational ones
    const situationalTools = tools.filter((t) => !CORE_TOOLS.includes(t.function.name));
    console.log(`[BOOTSTRAP] Storing ${situationalTools.length} situational tools.`);

    for (const tool of situationalTools) {
      const fn = tool.function;
      if (!fn || !fn.name) {
        console.warn("[BOOTSTRAP] Skipping tool with no function.name");
        continue;
      }
      const toolName = fn.name;
      // Embed the name + description so semantic search can find it based on user intent
      const embedText = `${toolName}: ${fn.description || ""}`;
      console.log(`[DB] Generating embedding for tool: ${toolName}...`);
      const embedding = await getEmbedding(embedText);

      await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
        await tx`
          INSERT INTO context_environment (
            agent_id, access_scope, tool_name, context_data, embedding
          ) VALUES (
            ${AGENT_ID}, 'global', ${toolName}, ${JSON.stringify(tool)}, ${JSON.stringify(embedding)}
          )
          ON CONFLICT (agent_id, tool_name) DO UPDATE SET 
            context_data = EXCLUDED.context_data,
            embedding = EXCLUDED.embedding;
        `;
      });
    }
    console.log("[DONE] Tools bootstrapped to database successfully.");
  } catch (err) {
    console.error("Bootstrap Error:", err);
  } finally {
    await sql.end();
  }
}

const targetFile = process.argv[2];
if (targetFile) bootstrapTools(targetFile);
else console.log("Usage: node scripts/bootstrap_tools.js <path_to_debug_prompt.json>");