// Parseur RSS 2.0 / Atom 1.0 tolérant, sans dépendance (pas de DOMParser
// dans les Workers). Basé sur des regex volontairement laxistes : un flux
// mal formé donne des items partiels plutôt qu'une exception.

export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: number; // unix seconds
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&eacute;': 'é', '&egrave;': 'è',
  '&agrave;': 'à', '&ccedil;': 'ç', '&ucirc;': 'û', '&ocirc;': 'ô',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => ENTITIES[m] ?? m);
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Premier tag trouvé parmi `names` dans `block` (contenu interne). */
function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1].trim();
  }
  return '';
}

/** Attribut href d'un <link> Atom (préférence rel="alternate"). */
function atomLink(block: string): string {
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback = '';
  for (const l of links) {
    const href = l.match(/href=["']([^"']+)["']/i)?.[1] ?? '';
    if (!href) continue;
    const rel = l.match(/rel=["']([^"']+)["']/i)?.[1] ?? 'alternate';
    if (rel === 'alternate') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

function parseDate(s: string): number {
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function clean(s: string, max: number): string {
  return decodeEntities(stripTags(stripCdata(s))).slice(0, max);
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const now = Math.floor(Date.now() / 1000);
  const blocks =
    xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ??
    [];
  for (const b of blocks.slice(0, 100)) {
    const title = clean(tag(b, ['title']), 400);
    let url = clean(tag(b, ['link']), 1000);
    if (!url || url.startsWith('<')) url = atomLink(b);
    if (!title || !url) continue;
    const guid = clean(tag(b, ['guid', 'id']), 500) || url;
    const summary = clean(tag(b, ['description', 'summary', 'content:encoded', 'content']), 1200);
    let publishedAt = parseDate(tag(b, ['pubDate', 'published', 'updated', 'dc:date']));
    if (!publishedAt || publishedAt > now + 86400) publishedAt = now;
    out.push({ guid, url, title, summary, publishedAt });
  }
  return out;
}
