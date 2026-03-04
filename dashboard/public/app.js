/**
 * PostClaw Dashboard — Frontend Application
 *
 * Tab management, API calls, DOM updates, D3 knowledge graph.
 */

// =============================================================================
// STATE
// =============================================================================

let currentAgent = "main";
let memoryPage = 0;
const PAGE_SIZE = 50;

// =============================================================================
// UTILITIES
// =============================================================================

function $(id) { return document.getElementById(id); }

async function api(method, path, body = null) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${path}${sep}agentId=${encodeURIComponent(currentAgent)}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API error");
  return data.data;
}

function toast(message, type = "info") {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function tierBadge(tier) {
  return `<span class="badge badge-${tier || 'daily'}">${tier || "daily"}</span>`;
}

function boolBadge(val) {
  return `<span class="badge badge-${val}">${val ? "✓" : "✗"}</span>`;
}

function truncate(str, len = 80) {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "…" : str;
}

// =============================================================================
// TAB MANAGEMENT
// =============================================================================

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");

    // Load data for the active tab
    if (btn.dataset.tab === "personas") loadPersonas();
    if (btn.dataset.tab === "memories") loadMemories();
    if (btn.dataset.tab === "graph") loadGraph();
  });
});

// =============================================================================
// AGENT SELECTOR
// =============================================================================

async function loadAgents() {
  try {
    const agents = await api("GET", "/api/agents");
    const select = $("agent-select");
    select.innerHTML = "";
    agents.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name || a.id;
      if (a.id === currentAgent) opt.selected = true;
      select.appendChild(opt);
    });
  } catch { /* agents table might be empty */ }
}

$("agent-select").addEventListener("change", (e) => {
  currentAgent = e.target.value;
  // Reload active tab
  const activeTab = document.querySelector(".tab-btn.active");
  if (activeTab) activeTab.click();
});

// =============================================================================
// PERSONAS
// =============================================================================

async function loadPersonas() {
  try {
    const personas = await api("GET", "/api/personas");
    const container = $("persona-list");
    if (personas.length === 0) {
      container.innerHTML = '<p class="hint">No persona entries yet. Create one above.</p>';
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Category</th><th>Content</th><th>Always Active</th><th>Actions</th>
        </tr></thead>
        <tbody>${personas.map(p => `
          <tr>
            <td><strong>${p.category}</strong></td>
            <td title="${p.content.replace(/"/g, '&quot;')}">${truncate(p.content, 120)}</td>
            <td>${boolBadge(p.is_always_active)}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editPersona('${p.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="deletePersonaRow('${p.id}', '${p.category}')">🗑️</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>`;
  } catch (err) { toast(err.message, "error"); }
}

// Store personas data for editing
let _personasCache = [];

async function editPersona(id) {
  try {
    const persona = await api("GET", `/api/personas/${id}`);
    $("persona-form-id").value = id;
    $("persona-category").value = persona.category;
    $("persona-content").value = persona.content;
    $("persona-always-active").checked = persona.is_always_active;
    $("persona-form").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
}
window.editPersona = editPersona;

async function deletePersonaRow(id, category) {
  if (!confirm(`Delete persona "${category}"?`)) return;
  try {
    await api("DELETE", `/api/personas/${id}`);
    toast("Persona deleted", "success");
    loadPersonas();
  } catch (err) { toast(err.message, "error"); }
}
window.deletePersonaRow = deletePersonaRow;

$("btn-new-persona").addEventListener("click", () => {
  $("persona-form-id").value = "";
  $("persona-category").value = "";
  $("persona-content").value = "";
  $("persona-always-active").checked = false;
  $("persona-form").style.display = "block";
});

$("btn-cancel-persona").addEventListener("click", () => {
  $("persona-form").style.display = "none";
});

$("btn-save-persona").addEventListener("click", async () => {
  const id = $("persona-form-id").value;
  const data = {
    category: $("persona-category").value,
    content: $("persona-content").value,
    is_always_active: $("persona-always-active").checked,
  };
  try {
    if (id) {
      await api("PUT", `/api/personas/${id}`, data);
      toast("Persona updated", "success");
    } else {
      await api("POST", "/api/personas", data);
      toast("Persona created", "success");
    }
    $("persona-form").style.display = "none";
    loadPersonas();
  } catch (err) { toast(err.message, "error"); }
});

// Workspace files
async function loadWorkspaceFiles() {
  try {
    const files = await api("GET", "/api/workspace-files");
    const container = $("workspace-files");
    if (files.length === 0) {
      container.innerHTML = '<span class="hint">No .md files found in workspace</span>';
      return;
    }
    container.innerHTML = files.map(f =>
      `<button class="workspace-file-btn" onclick="loadWorkspaceFile('${f.name}')">${f.name}</button>`
    ).join("");
  } catch { /* workspace might not be configured */ }
}
window.loadWorkspaceFile = async function(filename) {
  try {
    const file = await api("GET", `/api/workspace-files/${filename}`);
    $("workspace-content").textContent = file.content;
    $("workspace-content").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
};

// =============================================================================
// MEMORIES
// =============================================================================

async function loadMemories() {
  const search = $("memory-search").value;
  const tier = $("memory-tier-filter").value;
  const archived = $("memory-archived-filter").value;

  let params = `limit=${PAGE_SIZE}&offset=${memoryPage * PAGE_SIZE}`;
  if (search) params += `&search=${encodeURIComponent(search)}`;
  if (tier) params += `&tier=${tier}`;
  if (archived) params += `&archived=${archived}`;

  try {
    const result = await api("GET", `/api/memories?${params}`);
    const container = $("memory-list");
    const memories = result.memories;
    if (memories.length === 0) {
      container.innerHTML = '<p class="hint">No memories found.</p>';
      $("memory-pagination").innerHTML = "";
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Content</th><th>Category</th><th>Tier</th><th>Access</th><th>Actions</th>
        </tr></thead>
        <tbody>${memories.map(m => `
          <tr>
            <td title="${(m.content || '').replace(/"/g, '&quot;')}">${truncate(m.content, 100)}</td>
            <td>${m.category || "—"}</td>
            <td>${tierBadge(m.tier)}</td>
            <td>${m.access_count || 0}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editMemory('${m.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="archiveMemory('${m.id}')">🗑️</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>`;

    // Pagination
    const totalPages = Math.ceil(result.total / PAGE_SIZE);
    $("memory-pagination").innerHTML = totalPages > 1
      ? `<button class="btn-sm btn-secondary" ${memoryPage === 0 ? "disabled" : ""} onclick="memPrev()">← Prev</button>
         <span>Page ${memoryPage + 1} of ${totalPages} (${result.total} total)</span>
         <button class="btn-sm btn-secondary" ${memoryPage >= totalPages - 1 ? "disabled" : ""} onclick="memNext()">Next →</button>`
      : `<span>${result.total} memories</span>`;
  } catch (err) { toast(err.message, "error"); }
}

window.memPrev = () => { if (memoryPage > 0) { memoryPage--; loadMemories(); } };
window.memNext = () => { memoryPage++; loadMemories(); };

window.editMemory = async function(id) {
  try {
    const result = await api("GET", `/api/memories?limit=1&search=`);
    const mem = result.memories.find(m => m.id === id);
    if (!mem) return toast("Memory not found", "error");
    $("memory-form-id").value = id;
    $("memory-content").value = mem.content;
    $("memory-category").value = mem.category || "";
    $("memory-tier").value = mem.tier || "daily";
    $("memory-form").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
};

window.archiveMemory = async function(id) {
  if (!confirm("Archive this memory?")) return;
  try {
    await api("DELETE", `/api/memories/${id}`);
    toast("Memory archived", "success");
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
};

$("btn-new-memory").addEventListener("click", () => {
  $("memory-form-id").value = "";
  $("memory-content").value = "";
  $("memory-category").value = "";
  $("memory-tier").value = "daily";
  $("memory-form").style.display = "block";
  $("import-form").style.display = "none";
});

$("btn-cancel-memory").addEventListener("click", () => {
  $("memory-form").style.display = "none";
});

$("btn-save-memory").addEventListener("click", async () => {
  const id = $("memory-form-id").value;
  const data = {
    content: $("memory-content").value,
    category: $("memory-category").value || undefined,
    tier: $("memory-tier").value,
  };
  try {
    if (id) {
      await api("PUT", `/api/memories/${id}`, data);
      toast("Memory updated", "success");
    } else {
      await api("POST", "/api/memories", data);
      toast("Memory created", "success");
    }
    $("memory-form").style.display = "none";
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
});

// Import
$("btn-import-memory").addEventListener("click", () => {
  $("import-form").style.display = "block";
  $("memory-form").style.display = "none";
});
$("btn-cancel-import").addEventListener("click", () => {
  $("import-form").style.display = "none";
});
$("btn-run-import").addEventListener("click", async () => {
  const content = $("import-content").value;
  const filename = $("import-filename").value;
  if (!content.trim()) return toast("No content to import", "error");
  try {
    const result = await api("POST", "/api/memories/import", {
      content, source_filename: filename || undefined,
    });
    toast(`Imported ${result.imported} chunks`, "success");
    $("import-form").style.display = "none";
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
});

// Filter listeners
$("memory-search").addEventListener("input", debounce(() => { memoryPage = 0; loadMemories(); }, 300));
$("memory-tier-filter").addEventListener("change", () => { memoryPage = 0; loadMemories(); });
$("memory-archived-filter").addEventListener("change", () => { memoryPage = 0; loadMemories(); });

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// =============================================================================
// KNOWLEDGE GRAPH (D3.js)
// =============================================================================

let graphSimulation = null;

async function loadGraph() {
  try {
    const data = await api("GET", "/api/graph");
    renderGraph(data);
    $("graph-stats").textContent = `${data.nodes.length} nodes, ${data.edges.length} edges`;
  } catch (err) { toast(err.message, "error"); }
}

function renderGraph(data) {
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const container = $("graph-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr("viewBox", [0, 0, width, height]);

  // Color scale by tier
  const tierColor = {
    permanent: "#4ade80", stable: "#4f9cf7", daily: "#f7b955",
    session: "#a78bfa", volatile: "#f7555a",
  };

  // Relationship color scale
  const relColor = {
    related_to: "#6b7280", elaborates: "#4f9cf7", contradicts: "#f7555a",
    depends_on: "#f7b955", part_of: "#a78bfa",
  };

  if (graphSimulation) graphSimulation.stop();

  graphSimulation = d3.forceSimulation(data.nodes)
    .force("link", d3.forceLink(data.edges).id(d => d.id).distance(80))
    .force("charge", d3.forceManyBody().strength(-150))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(20));

  // Edges
  const link = svg.append("g")
    .selectAll("line")
    .data(data.edges)
    .join("line")
    .attr("class", "graph-edge")
    .attr("stroke", d => relColor[d.relationship] || "#6b7280")
    .attr("stroke-width", d => Math.sqrt(d.weight || 1));

  // Edge labels
  const linkLabel = svg.append("g")
    .selectAll("text")
    .data(data.edges)
    .join("text")
    .attr("class", "graph-edge-label")
    .text(d => d.relationship);

  // Nodes
  const node = svg.append("g")
    .selectAll("g")
    .data(data.nodes)
    .join("g")
    .attr("class", "graph-node")
    .call(d3.drag()
      .on("start", dragStart)
      .on("drag", dragging)
      .on("end", dragEnd));

  node.append("circle")
    .attr("r", d => 5 + (d.accessCount || 0) * 0.5)
    .attr("fill", d => tierColor[d.tier] || "#6b7280")
    .attr("stroke", "rgba(255,255,255,0.1)")
    .attr("stroke-width", 1);

  node.append("text")
    .text(d => d.label ? d.label.substring(0, 25) : "")
    .attr("dx", 12)
    .attr("dy", 4);

  node.on("click", (_event, d) => {
    $("graph-stats").textContent =
      `[${d.tier}] ${d.category || "—"} | ${d.label} | Access: ${d.accessCount || 0} | Score: ${(d.score || 0).toFixed(2)}`;
  });

  graphSimulation.on("tick", () => {
    link
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    linkLabel
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  function dragStart(event, d) {
    if (!event.active) graphSimulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragging(event, d) { d.fx = event.x; d.fy = event.y; }
  function dragEnd(event, d) {
    if (!event.active) graphSimulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
}

$("btn-refresh-graph").addEventListener("click", loadGraph);

// =============================================================================
// SCRIPTS
// =============================================================================

$("btn-run-sleep").addEventListener("click", async () => {
  const status = $("sleep-status");
  status.textContent = "Running...";
  status.className = "script-status running";
  try {
    await api("POST", "/api/scripts/sleep", { agentId: currentAgent });
    status.textContent = "Sleep cycle started! Check server logs for progress.";
    status.className = "script-status success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "script-status error";
  }
});

$("btn-run-persona-import").addEventListener("click", async () => {
  const file = $("persona-import-file").value;
  if (!file.trim()) return toast("Enter a file path", "error");
  const status = $("persona-import-status");
  status.textContent = "Running...";
  status.className = "script-status running";
  try {
    await api("POST", "/api/scripts/persona-import", { agentId: currentAgent, file });
    status.textContent = "Persona import started! Check server logs for progress.";
    status.className = "script-status success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "script-status error";
  }
});

// =============================================================================
// INIT
// =============================================================================

(async function init() {
  await loadAgents();
  loadPersonas();
  loadWorkspaceFiles();
})();
