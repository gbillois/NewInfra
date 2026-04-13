// Settings page logic: LLM provider/model, feeds CRUD, OPML/JSON import/export.

const $ = (s) => document.querySelector(s);

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateTime(epochSec) {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString();
}

function setStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.className = "muted" + (kind === "error" ? " error" : "");
}

// -- LLM settings --------------------------------------------------------
let defaults = {};

async function loadSettings() {
  const res = await fetch("/api/settings");
  const data = await res.json();
  defaults = data.defaults || {};
  const s = data.settings || {};
  $("#llm_provider").value = s.llm_provider || "workers-ai";
  $("#llm_model").value = s.llm_model || defaults[s.llm_provider || "workers-ai"] || "";
  $("#language").value = s.language || "fr";

  const caps = data.capabilities || {};
  const lines = [
    "État des backends sur ce déploiement :",
    `- Workers AI : ${caps.workers_ai ? "disponible" : "binding AI absent"}`,
    `- Anthropic : ${caps.anthropic ? "clé configurée" : "clé ANTHROPIC_API_KEY absente"}`,
    `- OpenAI : ${caps.openai ? "clé configurée" : "clé OPENAI_API_KEY absente"}`,
  ];
  $("#capabilities").innerHTML = lines.map(escapeHtml).join("<br>");
}

document.getElementById("llm_provider").addEventListener("change", (e) => {
  const p = e.target.value;
  if (defaults[p]) $("#llm_model").value = defaults[p];
});

document.getElementById("llm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    llm_provider: $("#llm_provider").value,
    llm_model: $("#llm_model").value.trim() || defaults[$("#llm_provider").value],
    language: $("#language").value,
  };
  setStatus($("#llm-status"), "Enregistrement…");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    setStatus($("#llm-status"), "Enregistré.");
  } catch (err) {
    setStatus($("#llm-status"), "Erreur : " + err.message, "error");
  }
});

// -- Feeds table ---------------------------------------------------------
async function loadFeeds() {
  const res = await fetch("/api/feeds");
  const { feeds } = await res.json();
  renderFeeds(feeds);
}

function renderFeeds(feeds) {
  const tbody = $("#feeds-table tbody");
  tbody.innerHTML = "";
  for (const f of feeds) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><input type="text" value="${escapeHtml(f.name)}" data-id="${f.id}" data-field="name" /></td>` +
      `<td><div class="feed-url">${escapeHtml(f.url)}</div></td>` +
      `<td><input type="checkbox" data-id="${f.id}" data-field="enabled" ${f.enabled ? "checked" : ""} /></td>` +
      `<td class="muted small">${escapeHtml(formatDateTime(f.last_fetched_at))}</td>` +
      `<td class="muted small">${escapeHtml(f.last_status || "—")}</td>` +
      `<td><button class="del-btn" data-id="${f.id}">Supprimer</button></td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".del-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("Supprimer ce flux (et les articles associés) ?")) return;
      const res = await fetch("/api/feeds/" + b.dataset.id, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setStatus($("#feeds-status"), "Erreur : " + (data.error || res.status), "error");
        return;
      }
      renderFeeds(data.feeds);
    });
  });

  tbody.querySelectorAll("input[data-field]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const id = inp.dataset.id;
      const field = inp.dataset.field;
      const body = {};
      body[field] = field === "enabled" ? inp.checked : inp.value;
      const res = await fetch("/api/feeds/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus($("#feeds-status"), "Erreur : " + (data.error || res.status), "error");
      } else {
        setStatus($("#feeds-status"), "Mis à jour.");
      }
    });
  });
}

document.getElementById("add-feed").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim();
  const url = f.url.value.trim();
  if (!name || !url) return;
  const res = await fetch("/api/feeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, url }),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus($("#feeds-status"), "Erreur : " + (data.error || res.status), "error");
    return;
  }
  f.reset();
  renderFeeds(data.feeds);
  setStatus($("#feeds-status"), "Flux ajouté.");
});

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let body, headers;
  if (file.name.endsWith(".json")) {
    headers = { "content-type": "application/json" };
    body = text;
  } else {
    headers = { "content-type": "text/xml" };
    body = text;
  }
  setStatus($("#feeds-status"), "Import en cours…");
  const res = await fetch("/api/feeds/import", { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok) {
    setStatus($("#feeds-status"), "Erreur : " + (data.error || res.status), "error");
    return;
  }
  renderFeeds(data.feeds);
  setStatus($("#feeds-status"), `${data.imported} nouveau(x) flux importé(s) (${data.total} dans le fichier).`);
  e.target.value = "";
});

async function setupLogout() {
  try {
    const r = await fetch("/api/login");
    const d = await r.json();
    if (!d.auth_enabled) return;
    const link = document.getElementById("logout-link");
    if (!link) return;
    link.hidden = false;
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      await fetch("/api/logout", { method: "POST" });
      location.href = "/login.html";
    });
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadFeeds();
  setupLogout();
});
