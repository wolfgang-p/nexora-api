'use strict';

/**
 * GET /util/og?url=<...>
 * Server-side Open Graph fetcher. Calling client passes a URL it
 * extracted from a message; we fetch the page (with strict size +
 * timeout caps), parse the OG / Twitter / standard <meta> tags, and
 * return a small JSON envelope the chat bubble renders as a card.
 *
 * Privacy note: this leaks the URL's domain to our API server. The
 * client only ever calls this AFTER decrypting a message it received,
 * so the leak is scoped to the receiving user's session — same as a
 * regular HTTPS GET they'd issue from their browser. Future tightening
 * could fetch from inside a TOR relay or rely on each peer fetching
 * locally.
 */

const { ok, badRequest, serverError } = require('./response');

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;

async function fetchOg(req, res, { query }) {
  const target = query.url;
  if (!target || typeof target !== 'string') return badRequest(res, 'url required');

  let parsed;
  try { parsed = new URL(target); } catch { return badRequest(res, 'invalid url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return badRequest(res, 'http(s) only');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(parsed.toString(), {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'KoroLinkPreview/1.0 (+https://koro.chat)',
        'Accept': 'text/html,*/*;q=0.5',
      },
    });
    if (!r.ok) return ok(res, { preview: null });
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) return ok(res, { preview: null });

    const reader = r.body.getReader();
    let received = 0;
    const chunks = [];
    while (received < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      chunks.push(value);
    }
    try { reader.cancel(); } catch { /* ignore */ }
    const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
    const html = buf.toString('utf8');

    const get = (re) => {
      const m = html.match(re);
      return m ? decodeEntities(m[1].trim()) : null;
    };

    const title =
      get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<title[^>]*>([^<]+)<\/title>/i);

    const description =
      get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

    const image =
      get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

    const siteName =
      get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
      parsed.hostname.replace(/^www\./, '');

    if (!title && !description && !image) {
      return ok(res, { preview: null });
    }

    ok(res, {
      preview: {
        url: parsed.toString(),
        title: trunc(title, 200),
        description: trunc(description, 400),
        image: image ? new URL(image, parsed).toString() : null,
        site_name: trunc(siteName, 120),
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') return ok(res, { preview: null });
    return serverError(res, 'fetch failed', err);
  } finally {
    clearTimeout(timer);
  }
}

function trunc(s, n) { if (!s) return null; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

module.exports = { fetchOg };
