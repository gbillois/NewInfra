// Build the synthesis for a given period: load articles in the time
// window, feed them to the configured LLM with a prompt that asks for
// cross-article clustering, and persist the result.

import { generate } from "./llm.js";
import { articlesInRange, getSettings, upsertSynthesis } from "./db.js";
import { periodBounds, formatDateUTC } from "./period.js";

// Trim article bodies before sending to the LLM: most feeds publish
// hundreds of words per item but the first ~600 chars of the summary
// carry the substance, and the full window can otherwise blow past
// context limits (especially for "month" with hundreds of articles).
function truncate(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function buildArticlesBlock(articles) {
  return articles
    .map((a, i) => {
      const date = a.published_at
        ? new Date(a.published_at * 1000).toISOString().slice(0, 10)
        : "n/a";
      const body = truncate(a.summary || "", 600);
      return `[A${i + 1}] (${date} · ${a.feed_name}) ${a.title}\nURL: ${a.url}\n${body}`;
    })
    .join("\n\n");
}

function systemPrompt(language) {
  const isFr = !language || language === "fr";
  if (isFr) {
    return [
      "Tu es un analyste en cybersécurité chargé de produire une veille synthétique.",
      "À partir d'une liste d'articles récents (RSS), tu dois :",
      "1. Regrouper les articles qui traitent du même événement ou du même thème (clustering).",
      "2. Pour chaque groupe, produire un paragraphe qui croise les sources, met en évidence les faits, les acteurs (APT, éditeurs, victimes), les CVE, les IOC si mentionnés, et l'impact.",
      "3. Citer les sources sous la forme [A1], [A2]… (en réutilisant les identifiants fournis).",
      "4. Ordonner les sections de la plus importante à la moins importante.",
      "5. Terminer par une courte section \"À surveiller\" si pertinent.",
      "Écris en français, en Markdown, avec des titres de niveau ## par cluster. Ne paraphrase pas les titres, apporte de la valeur analytique.",
    ].join("\n");
  }
  return [
    "You are a cybersecurity analyst producing a concise news digest.",
    "From the list of recent RSS articles, you must:",
    "1. Cluster articles covering the same event or theme.",
    "2. For each cluster, write a paragraph that cross-references the sources, highlights facts, actors (APTs, vendors, victims), CVEs, IOCs if mentioned, and impact.",
    "3. Cite sources as [A1], [A2]… using the provided identifiers.",
    "4. Order clusters from most to least important.",
    "5. End with a short \"What to watch\" section if relevant.",
    "Write in English, in Markdown, with ## headings per cluster.",
  ].join("\n");
}

function userPrompt(period, bounds, articles) {
  const label = {
    day: "journée",
    week: "semaine",
    fortnight: "quinzaine",
    month: "mois",
  }[period];
  const from = formatDateUTC(bounds.start);
  const to = formatDateUTC(bounds.end);
  const block = buildArticlesBlock(articles);
  return `Période : ${label} (du ${from} au ${to}, UTC).
Nombre d'articles : ${articles.length}.

Articles :

${block}

Produis la synthèse demandée maintenant.`;
}

export async function synthesizePeriod(env, period, refEpochSec) {
  const bounds = periodBounds(period, refEpochSec);
  const settings = await getSettings(env.DB);
  const articles = await articlesInRange(env.DB, bounds.start, bounds.end, {
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
      mode: "llm",
      content,
      article_ids: "[]",
      model: null,
      provider: null,
      article_count: 0,
    });
    return {
      period,
      period_start: bounds.start,
      period_end: bounds.end,
      article_count: 0,
      content,
    };
  }

  const system = systemPrompt(settings.language);
  const user = userPrompt(period, bounds, articles);

  const { text, model, provider } = await generate(env, settings, {
    system,
    user,
    maxTokens: period === "day" ? 2500 : 4000,
  });

  const ids = articles.map((a) => a.id);
  await upsertSynthesis(env.DB, {
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    mode: "llm",
    content: text,
    article_ids: JSON.stringify(ids),
    model,
    provider,
    article_count: articles.length,
  });

  return {
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    mode: "llm",
    article_count: articles.length,
    model,
    provider,
    content: text,
  };
}
