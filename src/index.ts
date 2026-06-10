import { collectAll } from './collect';
import { llmProvider } from './llm';
import { getOrComputeSet, refreshDaily, refreshLong, windowBounds, STANDARD_WINDOWS } from './trends';
import type { Env } from './types';

const COOKIE = 'nr_auth';
const DAY = 86400;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, url, env, ctx);
      }
      // Pages statiques : auth cookie obligatoire si APP_PASSWORD est défini.
      if (env.APP_PASSWORD && url.pathname !== '/login' && !(await isAuthed(request, env))) {
        return Response.redirect(new URL('/login', url).toString(), 302);
      }
      return await env.ASSETS.fetch(request);
    } catch (e: any) {
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case '13 * * * *':
        ctx.waitUntil(collectAll(env).then((s) => console.log('collect', JSON.stringify(s))));
        break;
      case '42 5 * * *':
        ctx.waitUntil(collectAll(env).then(() => refreshDaily(env)));
        break;
      case '7 6 * * 1':
        ctx.waitUntil(refreshLong(env));
        break;
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- auth

async function sha256hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  if (!env.APP_PASSWORD) return true;
  const cookie = request.headers.get('Cookie') ?? '';
  const m = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`));
  if (!m) return false;
  return m[1] === (await sha256hex(env.APP_PASSWORD));
}

// ---------------------------------------------------------------- api

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

async function handleApi(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    if (!env.APP_PASSWORD || body.password === env.APP_PASSWORD) {
      const token = await sha256hex(env.APP_PASSWORD ?? '');
      return json({ ok: true }, 200, {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * DAY}`,
      });
    }
    return json({ error: 'Mot de passe invalide' }, 401);
  }
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  }

  if (!(await isAuthed(request, env))) return json({ error: 'Non authentifié' }, 401);

  // ---- statut
  if (path === '/api/status' && method === 'GET') {
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM articles) AS articles,
              (SELECT COUNT(*) FROM articles WHERE duplicate_of IS NOT NULL) AS duplicates,
              (SELECT COUNT(*) FROM feeds WHERE enabled = 1) AS feeds,
              (SELECT MAX(last_fetched_at) FROM feeds) AS last_collect,
              (SELECT MAX(generated_at) FROM trend_sets) AS last_trends`
    ).first();
    return json({ ...counts, provider: llmProvider(env), auth: Boolean(env.APP_PASSWORD) });
  }

  // ---- tendances
  if (path === '/api/trends' && method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    let windowKey = url.searchParams.get('window') ?? '7d';
    let start: number, end: number;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from && to) {
      start = Math.floor(Date.parse(from) / 1000);
      end = Math.floor(Date.parse(to) / 1000) + DAY; // inclusif
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return json({ error: 'Période invalide' }, 400);
      }
      windowKey = 'custom';
    } else {
      if (!(STANDARD_WINDOWS as readonly string[]).includes(windowKey)) {
        return json({ error: 'Fenêtre invalide' }, 400);
      }
      ({ start, end } = windowBounds(windowKey));
    }
    const result = await getOrComputeSet(env, windowKey, start, end, force);
    return json(result);
  }

  const trendArticles = path.match(/^\/api\/trends\/(\d+)\/articles$/);
  if (trendArticles && method === 'GET') {
    const trendId = Number(trendArticles[1]);
    const rows = (await env.DB.prepare(
      `SELECT a.id, a.title, a.url, a.summary, a.published_at, f.name AS source, ta.weight,
              a.duplicate_of
       FROM trend_articles ta
       JOIN articles a ON a.id = ta.article_id
       JOIN feeds f ON f.id = a.feed_id
       WHERE ta.trend_id = ?
       ORDER BY ta.weight DESC, a.published_at DESC LIMIT 500`
    ).bind(trendId).all()).results;
    return json({ articles: rows });
  }

  // ---- flux
  if (path === '/api/feeds' && method === 'GET') {
    const rows = (await env.DB.prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS article_count
       FROM feeds f ORDER BY f.name`
    ).all()).results;
    return json({ feeds: rows });
  }
  if (path === '/api/feeds' && method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    if (!body.url || !/^https?:\/\//.test(body.url)) return json({ error: 'URL invalide' }, 400);
    const name = String(body.name || new URL(body.url).hostname).slice(0, 100);
    const row = await env.DB.prepare(
      'INSERT INTO feeds (url, name) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET enabled = 1 RETURNING *'
    ).bind(String(body.url).slice(0, 500), name).first();
    return json({ feed: row });
  }
  const feedId = path.match(/^\/api\/feeds\/(\d+)$/);
  if (feedId && method === 'PATCH') {
    const id = Number(feedId[1]);
    const body: any = await request.json().catch(() => ({}));
    if (typeof body.enabled === 'boolean') {
      await env.DB.prepare('UPDATE feeds SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, id).run();
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      await env.DB.prepare('UPDATE feeds SET name = ? WHERE id = ?').bind(body.name.trim().slice(0, 100), id).run();
    }
    return json({ ok: true });
  }
  if (feedId && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM feeds WHERE id = ?').bind(Number(feedId[1])).run();
    return json({ ok: true });
  }

  // ---- actions manuelles
  if (path === '/api/collect' && method === 'POST') {
    const stats = await collectAll(env);
    return json({ stats });
  }
  if (path === '/api/recompute' && method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const windowKey = String(body.window ?? '7d');
    if (!(STANDARD_WINDOWS as readonly string[]).includes(windowKey)) {
      return json({ error: 'Fenêtre invalide' }, 400);
    }
    const { start, end } = windowBounds(windowKey);
    const result = await getOrComputeSet(env, windowKey, start, end, true);
    return json(result);
  }

  return json({ error: 'Route inconnue' }, 404);
}
