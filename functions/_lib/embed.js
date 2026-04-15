// Embedding abstraction mirroring functions/_lib/llm.js.
// - Workers AI (default, multilingual): @cf/baai/bge-m3, 1024 dims.
// - OpenAI: text-embedding-3-small, 1536 dims.
// - Anthropic has no first-party embedding API; when the selected LLM
//   provider is 'anthropic' we fall back to Workers AI.
//
// The Vectorize index name is derived from (provider, model, dim) so
// that switching the embedding model doesn't try to write 1536-dim
// vectors into a 1024-dim index.

const WORKERS_AI_EMBED_MODEL = "@cf/baai/bge-m3";
const WORKERS_AI_EMBED_DIM = 1024;
const OPENAI_EMBED_MODEL = "text-embedding-3-small";
const OPENAI_EMBED_DIM = 1536;

// How much text we send per item. bge-m3 supports ~8192 tokens
// (≈30k chars for Latin scripts); OpenAI small is 8191 tokens.
// We stay under that comfortably.
const MAX_INPUT_CHARS = 24_000;

// Workers AI and OpenAI both accept batched inputs, but with per-request
// size limits. 16 items per batch is a conservative middle ground.
const BATCH_SIZE = 16;

export function pickEmbeddingConfig(settings) {
  const provider = settings.llm_provider || "workers-ai";
  if (provider === "openai") {
    return {
      provider: "openai",
      model: settings.vector_embed_model_openai || OPENAI_EMBED_MODEL,
      dim: OPENAI_EMBED_DIM,
      indexName: "articles-openai-small",
      // Cloudflare binding for the 1536-dim Vectorize index; see
      // .github/workflows/deploy.yml which provisions the index and
      // appends the [[vectorize]] block at deploy time.
      binding: "VECTORIZE_OPENAI",
    };
  }
  // workers-ai and anthropic → Workers AI bge-m3
  return {
    provider: "workers-ai",
    model: settings.vector_embed_model_workers_ai || WORKERS_AI_EMBED_MODEL,
    dim: WORKERS_AI_EMBED_DIM,
    indexName: "articles-bge-m3",
    binding: "VECTORIZE",
  };
}

// Resolve the Cloudflare Vectorize binding that matches the active
// embedding config. Throws a descriptive error when the binding is
// missing so the UI can surface a clear "provisioning not done" hint.
export function resolveVectorizeBinding(env, cfg) {
  const v = env[cfg.binding];
  if (!v) {
    throw new Error(
      `Vector mode requires the '${cfg.binding}' binding (${cfg.dim}-dim, cosine). ` +
        `Run 'wrangler vectorize create <name> --dimensions=${cfg.dim} --metric=cosine' ` +
        `and bind it as ${cfg.binding} in wrangler.toml — the deploy workflow does this automatically.`,
    );
  }
  return v;
}

function truncate(s) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > MAX_INPUT_CHARS
    ? s.slice(0, MAX_INPUT_CHARS - 1) + "…"
    : s;
}

async function embedWorkersAI(env, model, texts) {
  if (!env.AI) {
    throw new Error(
      "Embedding requires the Workers AI 'AI' binding, which is not configured.",
    );
  }
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(truncate);
    const res = await env.AI.run(model, { text: batch });
    // Workers AI returns { shape: [n, dim], data: number[][] }
    const data = res?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(
        `Workers AI embed returned unexpected shape for ${model}: ` +
          JSON.stringify(res).slice(0, 200),
      );
    }
    for (const v of data) vectors.push(v);
  }
  return vectors;
}

async function embedOpenAI(env, model, texts) {
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      "Embedding provider 'openai' selected but OPENAI_API_KEY is not set.",
    );
  }
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(truncate);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const items = data?.data;
    if (!Array.isArray(items) || items.length !== batch.length) {
      throw new Error("OpenAI embeddings returned unexpected shape");
    }
    // API returns items potentially out of order; sort by `index`.
    items.sort((a, b) => a.index - b.index);
    for (const it of items) vectors.push(it.embedding);
  }
  return vectors;
}

export async function embed(env, settings, texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    const cfg = pickEmbeddingConfig(settings);
    return { vectors: [], ...cfg };
  }
  const cfg = pickEmbeddingConfig(settings);
  const vectors =
    cfg.provider === "openai"
      ? await embedOpenAI(env, cfg.model, texts)
      : await embedWorkersAI(env, cfg.model, texts);
  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: expected ${texts.length}, got ${vectors.length}`,
    );
  }
  return { vectors, ...cfg };
}
