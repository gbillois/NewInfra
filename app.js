// Home page logic: period tabs, fetch synthesis, render markdown, wire
// the refresh button. No framework — we keep the bundle lean.

const PERIOD_LABELS = {
  day: "24 dernières heures",
  week: "7 derniers jours",
  fortnight: "15 derniers jours",
  month: "30 derniers jours",
};

const state = {
  period: "day",
  mode: localStorage.getItem("consolidation_mode") || "llm",
  synthesis: null,
  sources: [],
};

const $ = (s) => document.querySelector(s);
const statusEl = () => $("#status");
const synthesisEl = () => $("#synthesis");
const sourcesSection = () => $("#sources");
const sourcesList = () => $("#sources-list");
const metaEl = () => $("#meta-line");

// Wrapper around fetch() that bounces the user back to /login.html when
// the API says the session has expired, instead of swallowing the 401
// behind a generic "Erreur" toast.
async function apiFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status === 401) {
    const next = location.pathname + location.search;
    location.replace("/login.html?next=" + encodeURIComponent(next));
    // Throw so the caller's try/catch stops processing while the
    // navigation is in flight.
    throw new Error("session expirée");
  }
  return res;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tiny Markdown renderer. Handles the subset the LLM actually produces:
// headings, paragraphs, bold/italic/code, lists, links, blockquotes,
// and our [A1]/[A2] citation markers (turned into anchors to #src-N).
function renderMarkdown(md) {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inList = false;
  let listKind = null;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push("<p>" + inline(paraBuf.join(" ")) + "</p>");
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push(listKind === "ol" ? "</ol>" : "</ul>");
      inList = false;
      listKind = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      closeList();
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (!inList || listKind !== "ul") {
        closeList();
        out.push("<ul>");
        inList = true;
        listKind = "ul";
      }
      out.push("<li>" + inline(m[1]) + "</li>");
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (!inList || listKind !== "ol") {
        closeList();
        out.push("<ol>");
        inList = true;
        listKind = "ol";
      }
      out.push("<li>" + inline(m[1]) + "</li>");
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
      continue;
    }
    paraBuf.push(line);
  }
  flushPara();
  closeList();
  return out.join("\n");
}

function inline(text) {
  let s = escapeHtml(text);
  // code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // italic
  s = s.replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|\W)_([^_]+)_/g, "$1<em>$2</em>");
  // links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  // citation markers [A1], [A12]
  s = s.replace(
    /\[A(\d+)\]/g,
    '<a class="ref" href="#src-$1" data-ref="$1">[A$1]</a>',
  );
  return s;
}

function setStatus(msg, kind) {
  const el = statusEl();
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function formatDateTime(epochSec) {
  if (!epochSec) return "";
  return new Date(epochSec * 1000).toLocaleString();
}

function renderSources(articleIds) {
  const list = sourcesList();
  list.innerHTML = "";
  if (!articleIds || !articleIds.length) {
    sourcesSection().hidden = true;
    return;
  }
  // Fetch articles by ids in one call
  apiFetch("/api/articles?ids=" + encodeURIComponent(articleIds.join(",")))
    .then((r) => r.json())
    .then(({ articles }) => {
      // Map by id to preserve the [A1]=first-article order used in the synthesis
      const byId = new Map(articles.map((a) => [a.id, a]));
      let i = 0;
      for (const id of articleIds) {
        i++;
        const a = byId.get(id);
        if (!a) continue;
        const li = document.createElement("li");
        li.id = "src-" + i;
        li.innerHTML =
          `<div class="src-title"><span class="ref">[A${i}]</span> ` +
          `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a></div>` +
          `<div class="src-meta">${escapeHtml(a.feed_name || "")}${
            a.published_at ? " · " + formatDateTime(a.published_at) : ""
          }${a.author ? " · " + escapeHtml(a.author) : ""}</div>` +
          (a.summary
            ? `<div class="src-summary">${escapeHtml(a.summary.slice(0, 280))}${a.summary.length > 280 ? "…" : ""}</div>`
            : "");
        list.appendChild(li);
      }
      sourcesSection().hidden = false;
    })
    .catch((err) => {
      console.error("sources fetch failed", err);
      sourcesSection().hidden = true;
    });
}

async function loadSynthesis(period, mode) {
  if (period) state.period = period;
  if (mode) state.mode = mode;
  setStatus("Chargement de la synthèse…");
  synthesisEl().innerHTML = '<div class="placeholder">Chargement…</div>';
  sourcesSection().hidden = true;

  try {
    const res = await apiFetch(
      "/api/syntheses?period=" + state.period + "&mode=" + encodeURIComponent(state.mode),
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    renderSynthesisData(data);
    setStatus("");
  } catch (err) {
    setStatus("Erreur : " + err.message, "error");
    synthesisEl().innerHTML = '<div class="placeholder">Synthèse indisponible.</div>';
  }
}

const MODE_LABELS = {
  llm: "LLM",
  "vector-narrative": "vecteur + narratif",
  "vector-raw": "vecteur brut",
};

function renderSynthesisData(data) {
  const { synthesis, article_count_in_window, period, period_start, period_end, mode } = data;
  const label = PERIOD_LABELS[period] || period;
  const modeLabel = MODE_LABELS[mode] || mode;
  const from = new Date(period_start * 1000).toISOString().slice(0, 10);
  const to = new Date(period_end * 1000).toISOString().slice(0, 10);

  if (!synthesis) {
    synthesisEl().innerHTML =
      `<h2>Synthèse — ${escapeHtml(label)} · ${escapeHtml(modeLabel)}</h2>` +
      `<p class="muted">Du ${from} au ${to}. Aucune synthèse générée pour ce mode.</p>` +
      `<p>${article_count_in_window} article${article_count_in_window > 1 ? "s" : ""} collecté${
        article_count_in_window > 1 ? "s" : ""
      } dans la fenêtre. Cliquez sur « Rafraîchir la synthèse » pour en produire une.</p>`;
    metaEl().textContent = "";
    return;
  }

  synthesisEl().innerHTML =
    `<header style="margin-bottom:1rem">` +
    `<h2>Synthèse — ${escapeHtml(label)} · ${escapeHtml(modeLabel)}</h2>` +
    `<div class="muted small">Du ${from} au ${to} · ${synthesis.article_count} article${
      synthesis.article_count > 1 ? "s" : ""
    } analysé${synthesis.article_count > 1 ? "s" : ""}</div>` +
    `</header>` +
    renderMarkdown(synthesis.content);

  let ids = [];
  try {
    ids = JSON.parse(synthesis.article_ids || "[]");
  } catch {
    ids = [];
  }
  renderSources(ids);

  metaEl().textContent =
    `Généré le ${formatDateTime(synthesis.created_at)} · mode ${modeLabel}` +
    (synthesis.provider ? ` · ${synthesis.provider}/${synthesis.model || ""}` : "");
}

async function refresh() {
  const btn = $("#refresh-btn");
  btn.disabled = true;
  const longMsg =
    state.mode === "llm"
      ? "Collecte des flux et génération de la synthèse… (peut prendre 30–60s)"
      : "Collecte, récupération du texte intégral, embedding et clustering… (peut prendre 1–3 min au premier passage)";
  setStatus(longMsg);
  try {
    const res = await apiFetch("/api/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: state.period, mode: state.mode, collect: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    let msg = "Synthèse régénérée.";
    if (data.collect) {
      msg += ` ${data.collect.inserted} nouveau(x) article(s), ${data.collect.feeds_processed} flux.`;
      if (data.collect.errors && data.collect.errors.length) {
        msg += ` ${data.collect.errors.length} flux en erreur.`;
      }
    }
    if (data.synthesis && data.synthesis.cluster_count !== undefined) {
      msg += ` ${data.synthesis.cluster_count} cluster(s), ${data.synthesis.singletons || 0} isolé(s).`;
      if (data.synthesis.fulltext) {
        msg += ` Texte intégral : ${data.synthesis.fulltext.ok}/${data.synthesis.fulltext.attempted}.`;
      }
    }
    setStatus(msg, "ok");
    await loadSynthesis(state.period, state.mode);
  } catch (err) {
    setStatus("Erreur : " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

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

function selectMode(mode) {
  document.querySelectorAll(".modes .mode").forEach((b) =>
    b.setAttribute("aria-selected", b.dataset.mode === mode ? "true" : "false"),
  );
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".periods .period").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".periods .period").forEach((b) =>
        b.setAttribute("aria-selected", "false"),
      );
      btn.setAttribute("aria-selected", "true");
      loadSynthesis(btn.dataset.period, state.mode);
    });
  });
  document.querySelectorAll(".modes .mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectMode(btn.dataset.mode);
      localStorage.setItem("consolidation_mode", btn.dataset.mode);
      loadSynthesis(state.period, btn.dataset.mode);
    });
  });
  // Restore persisted mode selection on load.
  selectMode(state.mode);
  $("#refresh-btn").addEventListener("click", refresh);
  loadSynthesis("day", state.mode);
  setupLogout();
});
