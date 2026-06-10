import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './types';

// Abstraction LLM pour la synthèse de tendances :
//  - Claude (claude-opus-4-8) si ANTHROPIC_API_KEY est configurée — meilleur
//    regroupement et nommage des tendances, surtout en français ;
//  - repli 100 % Cloudflare sur Workers AI (Llama 3.3 70B) sinon.

const CLAUDE_MODEL = 'claude-opus-4-8';
const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

export function llmProvider(env: Env): string {
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'workers-ai';
}

/** Capacité d'entrée approximative (en items de liste) selon le provider. */
export function llmItemCapacity(env: Env): number {
  return env.ANTHROPIC_API_KEY ? 1500 : 450;
}

export async function llmTrends(env: Env, system: string, user: string): Promise<LlmResult> {
  if (env.ANTHROPIC_API_KEY) {
    return await claudeTrends(env, system, user);
  }
  return await workersAiTrends(env, system, user);
}

async function claudeTrends(env: Env, system: string, user: string): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: TREND_SCHEMA } },
  } as any);
  const text = (response as any).content.find((b: any) => b.type === 'text')?.text ?? '{}';
  return { trends: parseTrends(text), provider: 'anthropic', model: CLAUDE_MODEL };
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
