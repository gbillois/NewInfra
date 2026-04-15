// Vector consolidation pipeline.
//
//   articlesInRange
//     → lazily fetch full article text for articles missing it
//     → embed the ones we haven't embedded yet with the current model
//     → upsert vectors into Cloudflare Vectorize
//     → pull back vectors for the whole period and cluster them by
//       cosine similarity
//     → render either a plain Markdown list (mode='vector-raw') or a
//       short LLM-written paragraph per cluster (mode='vector-narrative')
//     → persist in the `syntheses` table alongside the existing LLM mode

import { generate } from "./llm.js";
import { embed, pickEmbeddingConfig } from "./embed.js";
import { clusterByThreshold } from "./cluster.js";
import { fetchFulltext } from "./fulltext.js";
import {
  articlesInRangeWithFulltext,
  getEmbeddedArticleIds,
  getSettings,
  getSynthesis,
  markEmbedded,
  updateArticleFulltext,
  upsertSynthesis,
} from "./db.js";
import { periodBounds, formatDateUTC } from "./period.js";

const FULLTEXT_RETRY_AFTER_SECS = 24 * 3600;
const FULLTEXT_CONCURRENCY = 8;
const CLUSTER_LLM_CONCURRENCY = 4;
const DEFAULT_THRESHOLD = 0.75;

function buildEmbeddingInput(article) {
  // Vector signal = title (strongest cue) + cleaned body text.
  // fulltext is authoritative when present; otherwise fall back to
  // summary so the pipeline still works for articles whose source page
  // couldn't be fetched.
  const body = article.fulltext || article.summary || article.content || "";
  return `${article.title}\n\n${body}`;
}

// Run tasks in parallel with a fixed concurrency ceiling.
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err };
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

function truncate(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function pickRepresentativeTitle(members, articles) {
  // Longest title tends to be the most descriptive; ties broken by
  // most recent published_at.
  let best = null;
  for (const idx of members) {
    const a = articles[idx];
    if (!best) {
      best = a;
      continue;
    }
    const ta = (a.title || "").length;
    const tb = (best.title || "").length;
    if (ta > tb) best = a;
    else if (ta === tb && (a.published_at || 0) > (best.published_at || 0)) {
      best = a;
    }
  }
  return best ? best.title : "Cluster";
}

function renderRaw(clusters, singletons, articles, avgIntra, language) {
  const isFr = language !== "en";
  const out = [];
  out.push(isFr ? "# Synthèse (clustering vectoriel)" : "# Digest (vector clustering)");
  out.push("");
  if (clusters.length === 0) {
    out.push(
      isFr
        ? "_Aucun regroupement significatif : chaque article est isolé pour le seuil courant._"
        : "_No significant clusters at the current threshold: every article stands alone._",
    );
  }
  let refIdx = 0;
  const refMap = new Map(); // article.id → [A1]-style index
  const pushRef = (a) => {
    refIdx++;
    refMap.set(a.id, refIdx);
    return refIdx;
  };

  clusters.forEach((members, ci) => {
    const title = pickRepresentativeTitle(members, articles);
    const sim = avgIntra[ci] || 0;
    const simPct = (sim * 100).toFixed(0);
    out.push(
      `## ${isFr ? "Cluster" : "Cluster"} ${ci + 1} — ${title} ` +
        `(${members.length} ${isFr ? "articles" : "articles"}, ` +
        `${isFr ? "similarité moyenne" : "avg similarity"} ${simPct}%)`,
    );
    // Sort cluster members by date desc for stable presentation.
    const sorted = [...members].sort((a, b) => {
      const pa = articles[a].published_at || 0;
      const pb = articles[b].published_at || 0;
      return pb - pa;
    });
    for (const idx of sorted) {
      const a = articles[idx];
      const ref = pushRef(a);
      const date = a.published_at
        ? new Date(a.published_at * 1000).toISOString().slice(0, 10)
        : "n/a";
      out.push(`- [A${ref}] [${a.title}](${a.url}) — ${a.feed_name} · ${date}`);
    }
    out.push("");
  });

  if (singletons.length) {
    out.push(isFr ? "## Articles isolés" : "## Standalone articles");
    const sorted = [...singletons].sort((a, b) => {
      const pa = articles[a].published_at || 0;
      const pb = articles[b].published_at || 0;
      return pb - pa;
    });
    for (const idx of sorted) {
      const a = articles[idx];
      const ref = pushRef(a);
      const date = a.published_at
        ? new Date(a.published_at * 1000).toISOString().slice(0, 10)
        : "n/a";
      out.push(`- [A${ref}] [${a.title}](${a.url}) — ${a.feed_name} · ${date}`);
    }
  }

  return { content: out.join("\n"), refMap };
}

function clusterSystemPrompt(language) {
  const isFr = language !== "en";
  if (isFr) {
    return [
      "Tu es un analyste en cybersécurité. On te fournit un cluster d'articles qui traitent tous du même sujet.",
      "Produis UN seul paragraphe (4-8 phrases) qui croise les sources, met en évidence les faits, les acteurs (APT, éditeurs, victimes), les CVE, les IOC, et l'impact.",
      "Cite les sources par leur identifiant [An]. Écris en français, sans titre, sans liste à puces.",
    ].join("\n");
  }
  return [
    "You are a cybersecurity analyst. You are given a cluster of articles that all cover the same topic.",
    "Produce ONE paragraph (4-8 sentences) cross-referencing the sources, highlighting facts, actors (APTs, vendors, victims), CVEs, IOCs, and impact.",
    "Cite sources by their identifier [An]. Write in English. No title, no bullet list.",
  ].join("\n");
}

function clusterUserPrompt(members, articles, globalRefMap, language) {
  const isFr = language !== "en";
  const lines = [];
  lines.push(isFr ? "Articles du cluster :" : "Articles in this cluster:");
  lines.push("");
  for (const idx of members) {
    const a = articles[idx];
    const ref = globalRefMap.get(a.id);
    const date = a.published_at
      ? new Date(a.published_at * 1000).toISOString().slice(0, 10)
      : "n/a";
    const body = truncate(a.fulltext || a.summary || a.content || "", 1200);
    lines.push(`[A${ref}] (${date} · ${a.feed_name}) ${a.title}`);
    lines.push(`URL: ${a.url}`);
    if (body) lines.push(body);
    lines.push("");
  }
  lines.push(
    isFr
      ? "Produis le paragraphe de synthèse maintenant."
      : "Write the cross-referenced paragraph now.",
  );
  return lines.join("\n");
}

async function renderNarrative(
  env,
  settings,
  clusters,
  singletons,
  articles,
  avgIntra,
) {
  const language = settings.language || "fr";
  const isFr = language !== "en";

  // Assign stable reference numbers once, shared across all LLM calls
  // so [A1]..[An] are consistent across clusters.
  const refMap = new Map();
  let refIdx = 0;
  for (const members of clusters) {
    for (const idx of members) {
      refIdx++;
      refMap.set(articles[idx].id, refIdx);
    }
  }
  for (const idx of singletons) {
    refIdx++;
    refMap.set(articles[idx].id, refIdx);
  }

  const system = clusterSystemPrompt(language);

  // Parallelize cluster summaries with a concurrency cap.
  const paragraphs = await mapWithConcurrency(
    clusters,
    CLUSTER_LLM_CONCURRENCY,
    async (members) => {
      const user = clusterUserPrompt(members, articles, refMap, language);
      const { text, model, provider } = await generate(env, settings, {
        system,
        user,
        maxTokens: 600,
      });
      return { text, model, provider };
    },
  );

  const out = [];
  out.push(
    isFr
      ? "# Synthèse (clustering vectoriel + narratif)"
      : "# Digest (vector clustering + narrative)",
  );
  out.push("");
  let firstModel = null;
  let firstProvider = null;
  clusters.forEach((members, ci) => {
    const res = paragraphs[ci];
    const title = pickRepresentativeTitle(members, articles);
    const sim = avgIntra[ci] || 0;
    const simPct = (sim * 100).toFixed(0);
    out.push(
      `## ${title} (${members.length} ${isFr ? "articles" : "articles"}, ` +
        `${isFr ? "similarité" : "similarity"} ${simPct}%)`,
    );
    if (res && res.__error) {
      out.push(
        (isFr
          ? "_Résumé indisponible : "
          : "_Summary unavailable: ") +
          String(res.__error.message || res.__error).slice(0, 200) +
          "_",
      );
    } else if (res) {
      out.push(res.text.trim());
      if (!firstModel) {
        firstModel = res.model;
        firstProvider = res.provider;
      }
    }
    out.push("");
  });

  if (singletons.length) {
    out.push(isFr ? "## Articles isolés" : "## Standalone articles");
    const sorted = [...singletons].sort((a, b) => {
      const pa = articles[a].published_at || 0;
      const pb = articles[b].published_at || 0;
      return pb - pa;
    });
    for (const idx of sorted) {
      const a = articles[idx];
      const ref = refMap.get(a.id);
      const date = a.published_at
        ? new Date(a.published_at * 1000).toISOString().slice(0, 10)
        : "n/a";
      out.push(`- [A${ref}] [${a.title}](${a.url}) — ${a.feed_name} · ${date}`);
    }
  }

  return {
    content: out.join("\n"),
    refMap,
    model: firstModel,
    provider: firstProvider,
  };
}

// Fetch full text for articles that are missing it (or whose last
// attempt is older than the retry window). Mutates `articles` in-place
// with the fresh `fulltext` value so downstream steps see it.
async function hydrateFulltext(env, articles) {
  const now = Math.floor(Date.now() / 1000);
  const needs = articles.filter((a) => {
    if (a.fulltext && a.fulltext.length >= 200) return false;
    if (
      a.fulltext_fetched_at &&
      now - a.fulltext_fetched_at < FULLTEXT_RETRY_AFTER_SECS
    ) {
      return false;
    }
    return true;
  });
  if (!needs.length) return { attempted: 0, ok: 0, failed: 0 };

  let ok = 0;
  let failed = 0;
  await mapWithConcurrency(needs, FULLTEXT_CONCURRENCY, async (article) => {
    const { text, status } = await fetchFulltext(article.url);
    await updateArticleFulltext(env.DB, article.id, text, status);
    if (text) {
      article.fulltext = text;
      article.fulltext_status = status;
      ok++;
    } else {
      article.fulltext_status = status;
      failed++;
    }
  });

  return { attempted: needs.length, ok, failed };
}

// Upsert missing embeddings into Vectorize and mark them in D1.
// Returns { model, dim, indexName, embedded } for caller diagnostics.
async function hydrateEmbeddings(env, settings, articles) {
  const cfg = pickEmbeddingConfig(settings);

  // Find which articles are already embedded with this exact model.
  const existingIds = await getEmbeddedArticleIds(
    env.DB,
    articles.map((a) => a.id),
    cfg.model,
  );
  const missing = articles.filter((a) => !existingIds.has(a.id));
  if (!missing.length) return { ...cfg, embedded: 0 };

  if (!env.VECTORIZE) {
    throw new Error(
      "Vector mode requires the VECTORIZE binding. Run " +
        `'wrangler vectorize create <index> --dimensions=${cfg.dim} --metric=cosine' ` +
        "and bind it as VECTORIZE in wrangler.toml.",
    );
  }

  const texts = missing.map(buildEmbeddingInput);
  const { vectors, model, dim, indexName } = await embed(env, settings, texts);

  // Vectorize upsert accepts up to ~1000 vectors per call; batch to be safe.
  const UPSERT_BATCH = 200;
  const records = vectors.map((values, i) => ({
    id: String(missing[i].id),
    values,
    metadata: {
      feed_id: missing[i].feed_id,
      published_at: missing[i].published_at || 0,
      title: (missing[i].title || "").slice(0, 200),
      url: missing[i].url,
    },
  }));
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    await env.VECTORIZE.upsert(records.slice(i, i + UPSERT_BATCH));
  }

  // Record in D1 so subsequent refreshes skip these.
  for (const a of missing) {
    await markEmbedded(env.DB, a.id, model, dim, indexName);
  }

  return { model, dim, indexName, provider: cfg.provider, embedded: missing.length };
}

// Pull the vectors for every article in the period (including ones we
// embedded in earlier refreshes). If Vectorize returns fewer vectors
// than requested, the missing ones are treated as absent and dropped.
async function loadVectorsForArticles(env, articles) {
  if (!env.VECTORIZE) {
    throw new Error(
      "Vector mode requires the VECTORIZE binding (see README for wrangler config).",
    );
  }
  const ids = articles.map((a) => String(a.id));
  const BATCH = 200;
  const vectorsById = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await env.VECTORIZE.getByIds(chunk);
    const arr = Array.isArray(res) ? res : res?.vectors || [];
    for (const v of arr) {
      if (v && v.id != null && Array.isArray(v.values)) {
        vectorsById.set(String(v.id), v.values);
      }
    }
  }
  return vectorsById;
}

export async function synthesizeVectorPeriod(env, period, mode, refEpochSec) {
  if (mode !== "vector-raw" && mode !== "vector-narrative") {
    throw new Error(`synthesizeVectorPeriod: unknown mode ${mode}`);
  }
  const bounds = periodBounds(period, refEpochSec);
  const settings = await getSettings(env.DB);
  const threshold = Number(settings.vector_similarity_threshold) || DEFAULT_THRESHOLD;

  const articles = await articlesInRangeWithFulltext(env.DB, bounds.start, bounds.end, {
    limit: period === "day" ? 150 : period === "week" ? 300 : 500,
  });

  if (articles.length === 0) {
    const content =
      settings.language === "en"
        ? "_No articles collected in this period yet._"
        : "_Aucun article collecté sur cette période pour le moment._";
    await upsertSynthesis(env.DB, {
      period,
      period_start: bounds.start,
      period_end: bounds.end,
      mode,
      content,
      article_ids: "[]",
      model: null,
      provider: null,
      article_count: 0,
    });
    return {
      period,
      mode,
      period_start: bounds.start,
      period_end: bounds.end,
      article_count: 0,
      content,
    };
  }

  // 1. Full text (lazy fetch).
  const fulltextReport = await hydrateFulltext(env, articles);

  // 2. Embeddings (for any article not yet embedded with the current model).
  const embedInfo = await hydrateEmbeddings(env, settings, articles);

  // 3. Pull all vectors for the period.
  const vectorsById = await loadVectorsForArticles(env, articles);

  // Filter to articles whose vector we actually have. Vectorize may lag
  // its own upsert by a few hundred ms in pathological cases; articles
  // we couldn't embed at all (e.g. Workers AI throttling) are dropped.
  const vectoredArticles = articles.filter((a) => vectorsById.has(String(a.id)));
  const vectors = vectoredArticles.map((a) => vectorsById.get(String(a.id)));

  if (vectoredArticles.length === 0) {
    const msg =
      settings.language === "en"
        ? "_Vector mode ran but no embeddings were available for this window._"
        : "_Le mode vectoriel s'est exécuté mais aucun embedding n'était disponible pour cette fenêtre._";
    await upsertSynthesis(env.DB, {
      period,
      period_start: bounds.start,
      period_end: bounds.end,
      mode,
      content: msg,
      article_ids: "[]",
      model: embedInfo.model,
      provider: embedInfo.provider,
      article_count: 0,
    });
    return {
      period,
      mode,
      period_start: bounds.start,
      period_end: bounds.end,
      article_count: 0,
      content: msg,
    };
  }

  // 4. Cluster.
  const { clusters, singletons, avgIntra, edges } = clusterByThreshold(vectors, {
    threshold,
  });

  // 5. Render.
  let rendered;
  let model = embedInfo.model;
  let provider = embedInfo.provider;
  if (mode === "vector-narrative") {
    rendered = await renderNarrative(
      env,
      settings,
      clusters,
      singletons,
      vectoredArticles,
      avgIntra,
    );
    if (rendered.model) model = rendered.model;
    if (rendered.provider) provider = rendered.provider;
  } else {
    rendered = renderRaw(
      clusters,
      singletons,
      vectoredArticles,
      avgIntra,
      settings.language,
    );
  }

  // Preserve per-article [A*] ordering in the `article_ids` list so the
  // frontend's source sidebar matches the [A1]..[An] citations in the
  // rendered Markdown.
  const orderedIds = [];
  for (const [id, _ref] of [...rendered.refMap.entries()].sort(
    (a, b) => a[1] - b[1],
  )) {
    orderedIds.push(id);
  }

  const content =
    rendered.content +
    `\n\n---\n\n` +
    (settings.language === "en"
      ? `_Vector mode · ${vectoredArticles.length} articles, ` +
        `${clusters.length} cluster(s), threshold=${threshold}, ` +
        `${edges} edges · fulltext fetched: ${fulltextReport.ok}/${fulltextReport.attempted} · ` +
        `embeddings: ${embedInfo.model} (${embedInfo.dim}d)_`
      : `_Mode vecteur · ${vectoredArticles.length} articles, ` +
        `${clusters.length} cluster(s), seuil=${threshold}, ` +
        `${edges} arêtes · texte intégral récupéré : ${fulltextReport.ok}/${fulltextReport.attempted} · ` +
        `embeddings : ${embedInfo.model} (${embedInfo.dim}d)_`);

  await upsertSynthesis(env.DB, {
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    mode,
    content,
    article_ids: JSON.stringify(orderedIds),
    model,
    provider,
    article_count: vectoredArticles.length,
  });

  return {
    period,
    mode,
    period_start: bounds.start,
    period_end: bounds.end,
    article_count: vectoredArticles.length,
    cluster_count: clusters.length,
    singletons: singletons.length,
    edges,
    fulltext: fulltextReport,
    embedded: embedInfo.embedded,
    model,
    provider,
    content,
  };
}
