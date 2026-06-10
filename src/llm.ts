import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './types';

// Abstraction LLM pour la synthèse de tendances :
//  - Anthropic ou OpenAI si la clé correspondante est configurée ;
//  - repli 100 % Cloudflare sur Workers AI sinon.

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const ANTHROPIC_MODELS = [
  { provider: 'anthropic', id: 'claude-fable-5', name: 'Claude Fable 5', description: 'Qualité maximale, coût élevé' },
  { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Très haute qualité' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Excellent équilibre qualité / coût' },
  { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Rapide et économique' },
] as const;
export const OPENAI_MODELS = [
  { provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', description: 'Qualité maximale' },
  { provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4', description: 'Très haute qualité' },
  { provider: 'openai', id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Rapide et économique' },
] as const;
export const MODEL_OPTIONS = [...ANTHROPIC_MODELS, ...OPENAI_MODELS] as const;

export interface LlmTrend {
  title: string;
  summary: string;
  theme: string;
  score: number;
  item_ids: number[];
}

export interface LlmResult {
  trends: LlmTrend[];
  provider: string;
  model: string;
}

const TREND_SCHEMA = {
  type: 'object',
  properties: {
    trends: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          theme: { type: 'string', enum: ['cyber', 'ia', 'tech', 'business', 'autre'] },
          score: { type: 'integer' },
          item_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'summary', 'theme', 'score', 'item_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['trends'],
  additionalProperties: false,
} as const;

export async function llmConfig(env: Env): Promise<{ provider: string; model: string }> {
  const rows = (await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('llm_provider', 'llm_model', 'anthropic_model')"
  ).all<{ key: string; value: string }>()).results;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const selected = MODEL_OPTIONS.find((option) =>
    option.provider === settings.llm_provider && option.id === settings.llm_model
  );
  if (selected && providerAvailable(env, selected.provider)) {
    return { provider: selected.provider, model: selected.id };
  }
  const legacyClaude = ANTHROPIC_MODELS.find((option) => option.id === settings.anthropic_model);
  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: legacyClaude?.id ?? DEFAULT_CLAUDE_MODEL };
  }
  if (env.OPENAI_API_KEY) return { provider: 'openai', model: DEFAULT_OPENAI_MODEL };
  return { provider: 'workers-ai', model: WORKERS_AI_MODEL };
}

export function providerAvailable(env: Env, provider: string): boolean {
  return provider === 'anthropic' ? Boolean(env.ANTHROPIC_API_KEY)
    : provider === 'openai' ? Boolean(env.OPENAI_API_KEY)
      : provider === 'workers-ai';
}

/** Capacité d'entrée approximative (en items de liste) selon le provider. */
export function llmItemCapacity(env: Env): number {
  return env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY ? 1500 : 450;
}

export async function llmTrends(env: Env, system: string, user: string): Promise<LlmResult> {
  const config = await llmConfig(env);
  if (config.provider === 'anthropic') return await claudeTrends(env, config.model, system, user);
  if (config.provider === 'openai') return await openAiTrends(env, config.model, system, user);
  return await workersAiTrends(env, system, user);
}

async function claudeTrends(env: Env, model: string, system: string, user: string): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    ...(model === 'claude-haiku-4-5' ? {} : { thinking: { type: 'adaptive' } }),
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: TREND_SCHEMA } },
  } as any);
  const text = (response as any).content.find((b: any) => b.type === 'text')?.text ?? '{}';
  return { trends: parseTrends(text), provider: 'anthropic', model };
}

async function openAiTrends(env: Env, model: string, system: string, user: string): Promise<LlmResult> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input: user,
      reasoning: { effort: 'medium' },
      max_output_tokens: 16000,
      text: {
        format: {
          type: 'json_schema',
          name: 'newsradar_trends',
          strict: true,
          schema: TREND_SCHEMA,
        },
      },
    }),
  });
  const result: any = await response.json();
  if (!response.ok) throw new Error(`OpenAI: ${result?.error?.message ?? `HTTP ${response.status}`}`);
  const text = result.output?.flatMap((item: any) => item.content ?? [])
    .find((content: any) => content.type === 'output_text')?.text ?? '{}';
  return { trends: parseTrends(text), provider: 'openai', model };
}

async function workersAiTrends(env: Env, system: string, user: string): Promise<LlmResult> {
  const res: any = await (env.AI as any).run(WORKERS_AI_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 4096,
    response_format: { type: 'json_schema', json_schema: TREND_SCHEMA },
  });
  const raw = res?.response ?? res;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { trends: parseTrends(text), provider: 'workers-ai', model: WORKERS_AI_MODEL };
}

function parseTrends(text: string): LlmTrend[] {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Repli : extraire le premier objet JSON de la réponse.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse LLM non parsable');
    parsed = JSON.parse(m[0]);
  }
  const list = Array.isArray(parsed?.trends) ? parsed.trends : [];
  return list
    .filter((t: any) => t && typeof t.title === 'string' && Array.isArray(t.item_ids))
    .map((t: any) => ({
      title: String(t.title).slice(0, 200),
      summary: String(t.summary ?? '').slice(0, 1000),
      theme: String(t.theme ?? 'autre').slice(0, 20),
      score: Math.max(0, Math.min(100, Number(t.score) || 0)),
      item_ids: t.item_ids.map((n: any) => Number(n)).filter(Number.isFinite),
    }));
}
