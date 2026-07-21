export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  /** Mot de passe partagé. Si absent, l'app est publique (premier déploiement). */
  APP_PASSWORD?: string;
  /** Si présent, les modèles Claude deviennent disponibles dans le sélecteur. */
  ANTHROPIC_API_KEY?: string;
  /** Si présent, les modèles OpenAI deviennent disponibles dans le sélecteur. */
  OPENAI_API_KEY?: string;
  /** Si présent, le catalogue unifié OpenRouter devient disponible. */
  OPENROUTER_API_KEY?: string;
}

export interface FeedRow {
  id: number;
  url: string;
  name: string;
  enabled: number;
  last_fetched_at: number | null;
  last_status: string | null;
}

export interface TrendRow {
  id: number;
  set_id: number;
  rank: number;
  title: string;
  summary: string | null;
  theme: string | null;
  score: number;
  article_count: number;
}

export interface TrendSetRow {
  id: number;
  window_key: string;
  period_start: number;
  period_end: number;
  generated_at: number;
  article_count: number;
  provider: string | null;
  model: string | null;
}
