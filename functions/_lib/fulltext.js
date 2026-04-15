// Fetch the full article text from a source URL and extract the main
// body. RSS items often ship only a short summary (or none at all),
// which is too thin a signal for vector clustering. This module pulls
// the real page and strips it to plain text.
//
// Design notes:
// - Extraction uses HTMLRewriter (native in the Workers runtime), not
//   regex or a DOM library. HTMLRewriter streams the response so we
//   never hold the full HTML in memory.
// - We preferentially keep content from the first <article> element,
//   falling back to <main>, then to a heuristic "longest run of <p>".
// - Noise tags (nav, aside, header, footer, form, script, style,
//   figure captions, share buttons) are dropped before text accumulation.
// - Returns { text, status } where status is one of:
//   'ok' | 'non-html' | 'empty' | 'http:<code>' | 'error:<msg>' | 'timeout'
// - Never throws: every exception is converted to an 'error:' status
//   so the caller can continue clustering without this article's text.

const MAX_CHARS = 50_000; // D1/Vectorize-friendly cap
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "NewInfraBot/1.0 (+cyber-news-aggregator)";

// Tags whose content should never appear in the extracted text.
const DROP_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "aside",
  "header",
  "footer",
  "form",
  "iframe",
  "svg",
  "button",
  "figure",
  "figcaption",
];

// Collects text from child nodes while ignoring nested drop tags.
class TextCollector {
  constructor() {
    this.parts = [];
    this.charCount = 0;
    this.dropDepth = 0;
  }
  pushText(s) {
    if (this.dropDepth > 0) return;
    if (!s) return;
    // Collapse whitespace runs; HTMLRewriter emits text chunks as-is.
    const cleaned = s.replace(/\s+/g, " ");
    if (!cleaned.trim()) return;
    this.parts.push(cleaned);
    this.charCount += cleaned.length;
  }
  pushParagraphBreak() {
    if (this.dropDepth > 0) return;
    if (this.parts.length && this.parts[this.parts.length - 1] !== "\n\n") {
      this.parts.push("\n\n");
    }
  }
  result() {
    return this.parts
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_CHARS);
  }
}

// Build a HTMLRewriter pipeline that captures <article> / <main> content
// into `collector`. We use `capturedContainer` to track which container
// we've locked onto: the first <article> wins; if none, the first <main>;
// if neither, fall back to <body> collected with stronger filtering.
function buildRewriter(collector, containerState) {
  const rw = new HTMLRewriter();

  // Drop noise tags entirely.
  for (const tag of DROP_TAGS) {
    rw.on(tag, {
      element(el) {
        collector.dropDepth++;
        el.onEndTag(() => {
          collector.dropDepth--;
        });
      },
    });
  }

  // Article / main: lock onto the first occurrence.
  const handleContainer = (priority) => ({
    element(el) {
      if (containerState.activePriority <= priority) return; // already locked to higher
      containerState.activePriority = priority;
      containerState.inside = true;
      el.onEndTag(() => {
        containerState.inside = false;
      });
    },
  });
  rw.on("article", handleContainer(1));
  rw.on("main", handleContainer(2));

  // Paragraph-like breaks for readability of the extracted text.
  for (const tag of ["p", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6"]) {
    rw.on(tag, {
      element(_el) {
        if (!containerState.inside && containerState.activePriority < 3) return;
        collector.pushParagraphBreak();
      },
    });
  }

  // Text capture — active only while we're inside the locked container
  // (or, if we never locked onto one, after the entire pass completes
  // we fall back to a second pass over <body>; see fetchFulltext below).
  rw.on("*", {
    text(chunk) {
      if (!containerState.inside) return;
      collector.pushText(chunk.text);
    },
  });

  return rw;
}

// Second-pass extractor: used when no <article> or <main> was found on
// the page. Collects <p> content from <body> to produce *something*
// rather than an empty string.
function buildBodyFallbackRewriter(collector) {
  const rw = new HTMLRewriter();
  for (const tag of DROP_TAGS) {
    rw.on(tag, {
      element(el) {
        collector.dropDepth++;
        el.onEndTag(() => {
          collector.dropDepth--;
        });
      },
    });
  }
  let insideP = false;
  rw.on("p", {
    element(el) {
      collector.pushParagraphBreak();
      insideP = true;
      el.onEndTag(() => {
        insideP = false;
      });
    },
  });
  rw.on("p *, p", {
    text(chunk) {
      if (!insideP) return;
      collector.pushText(chunk.text);
    },
  });
  return rw;
}

// Run an HTMLRewriter pipeline against a Response body, awaiting full
// consumption. We have to actually read the stream for the rewriter
// handlers to fire — `.arrayBuffer()` on the transformed response does it.
async function runRewriter(response, rewriter) {
  const transformed = rewriter.transform(response);
  // Consuming the body drives the rewriter; we don't need the result.
  await transformed.arrayBuffer();
}

export async function fetchFulltext(url) {
  if (!url || typeof url !== "string") {
    return { text: null, status: "error:no-url" };
  }

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en,fr;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 140);
    if (/timeout|aborted/i.test(msg)) return { text: null, status: "timeout" };
    return { text: null, status: `error:${msg}` };
  }

  if (!response.ok) {
    // Drain to avoid leaking the stream.
    try {
      await response.body?.cancel();
    } catch (_) {}
    return { text: null, status: `http:${response.status}` };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/html|xml/i.test(contentType)) {
    try {
      await response.body?.cancel();
    } catch (_) {}
    return { text: null, status: "non-html" };
  }

  // First pass: try <article>/<main>.
  const collector = new TextCollector();
  const containerState = { inside: false, activePriority: 99 };
  try {
    await runRewriter(response, buildRewriter(collector, containerState));
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 140);
    return { text: null, status: `error:${msg}` };
  }

  let text = collector.result();

  // If the primary extraction came up empty (no <article>/<main>), refetch
  // and run the body fallback. Two fetches are unfortunate but Workers
  // HTMLRewriter consumes the body and we can't tee it cheaply.
  if (!text || text.length < 200) {
    let fallbackRes;
    try {
      fallbackRes = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en,fr;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 140);
      if (text) return { text, status: "ok" };
      return { text: null, status: `error:${msg}` };
    }
    if (fallbackRes.ok) {
      const fb = new TextCollector();
      try {
        await runRewriter(fallbackRes, buildBodyFallbackRewriter(fb));
      } catch (_) {
        // ignore, use whatever we got from the first pass
      }
      const fbText = fb.result();
      if (fbText.length > text.length) text = fbText;
    } else {
      try {
        await fallbackRes.body?.cancel();
      } catch (_) {}
    }
  }

  if (!text) return { text: null, status: "empty" };
  return { text, status: "ok" };
}
