import { getSettings, setSetting } from "../_lib/db.js";
import { defaultModelFor } from "../_lib/llm.js";

// GET  /api/settings   → current settings + which API keys are configured
// PUT  /api/settings   → body { llm_provider?, llm_model?, language? }
const ALLOWED_KEYS = new Set(["llm_provider", "llm_model", "language"]);
const ALLOWED_PROVIDERS = new Set(["workers-ai", "anthropic", "openai"]);
const ALLOWED_LANGUAGES = new Set(["fr", "en"]);

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }

  if (request.method === "GET") {
    const settings = await getSettings(env.DB);
    return Response.json({
      settings,
      capabilities: {
        workers_ai: Boolean(env.AI),
        anthropic: Boolean(env.ANTHROPIC_API_KEY),
        openai: Boolean(env.OPENAI_API_KEY),
      },
      defaults: {
        "workers-ai": defaultModelFor("workers-ai"),
        anthropic: defaultModelFor("anthropic"),
        openai: defaultModelFor("openai"),
      },
    });
  }

  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.llm_provider && !ALLOWED_PROVIDERS.has(body.llm_provider)) {
    return Response.json({ error: "invalid llm_provider" }, { status: 400 });
  }
  if (body.language && !ALLOWED_LANGUAGES.has(body.language)) {
    return Response.json({ error: "invalid language" }, { status: 400 });
  }

  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    await setSetting(env.DB, k, v.trim());
  }

  // If provider changed but no model was supplied, reset model to the
  // provider's default so we don't leave a stale model id in settings.
  if (body.llm_provider && !body.llm_model) {
    await setSetting(env.DB, "llm_model", defaultModelFor(body.llm_provider));
  }

  return Response.json({ settings: await getSettings(env.DB) });
}
