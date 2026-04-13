// Minimal RSS 2.0 / Atom 1.0 parser. We intentionally avoid an npm
// dependency: Cloudflare Workers have no DOMParser for XML, and a
// regex-driven parser is robust enough for the well-formed feeds that
// real publishers produce. Returns a normalized `{ title, url, guid,
// author, summary, content, published_at }` shape for each item.

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => HTML_ENTITIES[n] ?? m);
}

function stripCdata(s) {
  if (!s) return s;
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(s) {
  if (!s) return s;
  return stripCdata(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getTag(block, tag) {
  // Match <tag ...>inner</tag> (ns-prefixed too, eg dc:creator). Non-greedy.
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`,
    "i",
  );
  const m = block.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1])).trim();
}

function getAttr(block, tag, attr) {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*\\s${attr}="([^"]+)"`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

function extractItems(xml, openTag, closeTag) {
  const items = [];
  const re = new RegExp(`<${openTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${closeTag}>`, "gi");
  let m;
  while ((m = re.exec(xml))) {
    items.push(m[1]);
  }
  return items;
}

export function parseFeed(xml) {
  if (!xml || typeof xml !== "string") {
    throw new Error("parseFeed: empty or non-string input");
  }
  // Trim BOM / leading whitespace.
  xml = xml.replace(/^\uFEFF/, "").trim();

  const isAtom = /<feed[\s>][^]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(
    xml,
  );

  if (isAtom) {
    const entries = extractItems(xml, "entry", "entry");
    return entries.map((e) => {
      const title = getTag(e, "title") || "";
      // <link href="..."/> is preferred; fall back to <link>url</link>.
      let url = getAttr(e, "link", "href");
      if (!url) url = getTag(e, "link") || "";
      const id = getTag(e, "id") || url;
      const published = getTag(e, "published") || getTag(e, "updated");
      const author =
        getTag(e, "author") && getTag(getTag(e, "author") || "", "name");
      const summary = stripHtml(getTag(e, "summary") || "");
      const content = stripHtml(
        getTag(e, "content") || getTag(e, "summary") || "",
      );
      return {
        title: stripHtml(title),
        url,
        guid: id,
        author: author ? stripHtml(author) : null,
        summary: summary || null,
        content: content || null,
        published_at: parseDate(published),
      };
    });
  }

  // RSS 2.0
  const items = extractItems(xml, "item", "item");
  return items.map((it) => {
    const title = getTag(it, "title") || "";
    const url = getTag(it, "link") || "";
    const guid = getTag(it, "guid") || url;
    const pub = getTag(it, "pubDate") || getTag(it, "date");
    const author = getTag(it, "creator") || getTag(it, "author");
    const desc = stripHtml(getTag(it, "description") || "");
    const encoded = stripHtml(getTag(it, "encoded") || "");
    return {
      title: stripHtml(title),
      url,
      guid,
      author: author ? stripHtml(author) : null,
      summary: desc || null,
      content: encoded || desc || null,
      published_at: parseDate(pub),
    };
  });
}

export async function fetchAndParseFeed(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some publishers (BleepingComputer) 403 the default Workers UA.
        "user-agent":
          "Mozilla/5.0 (compatible; NewInfraCyberNewsBot/1.0; +https://newinfragg.pages.dev)",
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const xml = await res.text();
    return parseFeed(xml);
  } finally {
    clearTimeout(t);
  }
}
