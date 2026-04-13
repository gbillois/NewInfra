// LLM provider abstraction. One `generate({ system, user })` entry
// point that dispatches to Workers AI, Anthropic, or OpenAI based on
// settings. API keys live in Cloudflare environment secrets, NOT in D1
// — the settings table only stores the provider/model choice.

const DEFAULT_MODELS = {
  "workers-ai": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

export function defaultModelFor(provider) {
  return DEFAULT_MODELS[provider] || DEFAULT_MODELS["workers-ai"];
}

export async function generate(env, settings, { system, user, maxTokens = 2500 }) {
  const provider = settings.llm_provider || "workers-ai";
  const model = settings.llm_model || defaultModelFor(provider);

  if (provider === "workers-ai") {
    if (!env.AI) {
      throw new Error(
        "Workers AI is selected but the 'AI' binding is not configured on this deployment.",
      );
    }
    const res = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    });
    // Workers AI returns { response: "..." } for chat models.
    const text = res?.response ?? res?.result?.response ?? "";
    if (!text) throw new Error("Workers AI returned no text");
    return { text, model, provider };
  }

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Provider 'anthropic' selected but ANTHROPIC_API_KEY secret is not set.",
      );
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Anthropic returned no text");
    return { text, model, provider };
  }

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        "Provider 'openai' selected but OPENAI_API_KEY secret is not set.",
      );
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("OpenAI returned no text");
    return { text, model, provider };
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
