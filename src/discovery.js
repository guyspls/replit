import * as cheerio from 'cheerio';
import { logger } from './logger.js';
import { getPath } from './extract.js';

const log = logger('discover');

/**
 * Discovery finds product URLs you do not have yet. It is the earliest warning
 * the bot can give: retailers publish a SKU to their sitemap or search index
 * days before the listing is linked anywhere a shopper would see it.
 */
export async function runDiscovery(source, { fetcher, store }) {
  const url = source.url.replace('{query}', encodeURIComponent(source.query ?? source.keywords[0]));
  const res = await fetcher.get(url, {
    respectRobots: source.respectRobots,
    headers: source.headers,
    mode: source.mode,
    browser: source.browser,
  });

  if (res.skipped) return { skipped: true, reason: res.reason, items: [] };
  if (res.error) return { error: res.error, items: [] };
  if (res.throttled) return { throttled: true, items: [] };
  if (res.status >= 400) return { error: `HTTP ${res.status}`, items: [] };

  let candidates;
  switch (source.kind) {
    case 'sitemap':
      candidates = parseSitemap(res.body, url);
      break;
    case 'feed':
      candidates = parseFeed(res.body);
      break;
    case 'search':
      candidates = parseSearch(res, source);
      break;
    default:
      return { error: `unknown discovery kind: ${source.kind}`, items: [] };
  }

  const matched = candidates.filter((c) => matchesKeywords(`${c.title ?? ''} ${c.url ?? ''}`, source));
  const fresh = store.markSeen(source.id, matched.map((m) => m.key));
  const freshSet = new Set(fresh);

  log.debug(`${source.id}: ${candidates.length} candidates, ${matched.length} matched, ${fresh.length} new`);
  return { items: matched.filter((m) => freshSet.has(m.key)), scanned: candidates.length, matched: matched.length };
}

/** Handles both a urlset and a sitemap index (which points at more sitemaps). */
export function parseSitemap(xml, baseUrl) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];

  $('sitemapindex > sitemap > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) out.push({ url: loc, key: loc, kind: 'sitemap-index', title: loc });
  });

  $('urlset > url').each((_, el) => {
    const node = $(el);
    const loc = node.find('loc').first().text().trim();
    if (!loc) return;
    const lastmod = node.find('lastmod').first().text().trim() || null;
    out.push({ url: loc, key: loc, title: titleFromUrl(loc), lastmod, kind: 'sitemap' });
  });

  if (out.length === 0) {
    // Some sitemaps ship without namespaces or with odd nesting; fall back to
    // scraping every <loc> regardless of position.
    $('loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) out.push({ url: loc, key: loc, title: titleFromUrl(loc), kind: 'sitemap' });
    });
  }

  return dedupe(out, baseUrl);
}

/** RSS and Atom, which is how most restock trackers and brand blogs publish. */
export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];

  $('item').each((_, el) => {
    const node = $(el);
    const link = node.find('link').first().text().trim();
    const title = node.find('title').first().text().trim();
    const description = node.find('description').first().text().trim();
    out.push({ url: link, title: `${title} ${description}`.trim(), key: node.find('guid').first().text().trim() || link || title, kind: 'rss' });
  });

  $('entry').each((_, el) => {
    const node = $(el);
    const link = node.find('link').first().attr('href') ?? '';
    const title = node.find('title').first().text().trim();
    const summary = node.find('summary, content').first().text().trim();
    out.push({ url: link, title: `${title} ${summary}`.trim(), key: node.find('id').first().text().trim() || link || title, kind: 'atom' });
  });

  return dedupe(out);
}

/** A site's own search/product JSON API, which is the fastest index there is. */
export function parseSearch(res, source) {
  const json = res.page?.json ?? safeParse(res.body);
  if (!json) {
    // Not JSON — treat it as a search results page and read the links.
    const $ = cheerio.load(res.body);
    const selector = source.itemSelector ?? 'a[href]';
    const out = [];
    $(selector).each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = absolute(href, res.url ?? source.url);
      if (!abs) return;
      out.push({ url: abs, title: $(el).text().replace(/\s+/g, ' ').trim() || titleFromUrl(abs), key: abs, kind: 'search-html' });
    });
    return dedupe(out);
  }

  const items = getPath(json, source.itemsPath ?? 'results[]');
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return dedupe(
    list.map((item) => {
      const url = absolute(String(getPath(item, source.urlPath ?? 'url') ?? ''), source.url);
      const title = String(getPath(item, source.titlePath ?? 'title') ?? '');
      const id = getPath(item, source.idPath ?? 'id');
      return { url, title, key: String(id ?? url ?? title), kind: 'search-json', raw: item };
    }),
  );
}

export function matchesKeywords(haystack, { keywords, matchAll = false, exclude = [] }) {
  const text = String(haystack).toLowerCase();
  for (const term of exclude) {
    if (text.includes(String(term).toLowerCase())) return false;
  }
  const hits = keywords.filter((k) => {
    const term = String(k);
    // A term wrapped in slashes is a regex: /rtx.?5090/
    if (term.startsWith('/') && term.lastIndexOf('/') > 0) {
      const end = term.lastIndexOf('/');
      try {
        return new RegExp(term.slice(1, end), `${term.slice(end + 1)}i`).test(text);
      } catch {
        return false;
      }
    }
    return text.includes(term.toLowerCase());
  });
  return matchAll ? hits.length === keywords.length : hits.length > 0;
}

/** Turns a discovery hit into a watch target so the drop itself is covered. */
export function targetFromDiscovery(item, source) {
  const template = source.watchTemplate ?? {};
  return {
    ...template,
    id: `${source.id}-${hashKey(item.key)}`,
    name: template.name ?? item.title?.slice(0, 80) ?? titleFromUrl(item.url),
    url: item.url,
    discoveredBy: source.id,
    discoveredAt: new Date().toISOString(),
  };
}

function dedupe(items, baseUrl) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const url = item.url ? absolute(item.url, baseUrl) ?? item.url : item.url;
    const key = item.key || url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, url, key });
  }
  return out;
}

function absolute(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function titleFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? url).replace(/[-_]+/g, ' ');
  } catch {
    return url;
  }
}

function hashKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
