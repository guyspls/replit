import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, parseFeed, parseSearch, matchesKeywords, targetFromDiscovery, runDiscovery } from '../src/discovery.js';
import { createPage } from '../src/extract.js';
import { Store } from '../src/state.js';

test('sitemaps yield product URLs with a readable title', () => {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://s.test/p/rtx-5090-founders</loc><lastmod>2026-09-01</lastmod></url>
    <url><loc>https://s.test/p/toaster</loc></url></urlset>`;
  const items = parseSitemap(xml, 'https://s.test');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'rtx 5090 founders');
  assert.equal(items[0].lastmod, '2026-09-01');
});

test('a sitemap index is recognised so nested sitemaps can be followed', () => {
  const xml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://s.test/sitemap-products-1.xml</loc></sitemap></sitemapindex>`;
  const items = parseSitemap(xml, 'https://s.test');
  assert.equal(items[0].kind, 'sitemap-index');
});

test('a namespace-less sitemap still parses via the loc fallback', () => {
  const items = parseSitemap('<foo><bar><loc>https://s.test/p/x</loc></bar></foo>', 'https://s.test');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://s.test/p/x');
});

test('both RSS and Atom feeds are understood', () => {
  const rss = parseFeed('<rss><channel><item><title>RTX 5090 restock</title><link>https://x.test/1</link><guid>g1</guid></item></channel></rss>');
  assert.equal(rss[0].key, 'g1');
  assert.match(rss[0].title, /RTX 5090/);

  const atom = parseFeed('<feed><entry><title>Console drop</title><link href="https://x.test/2"/><id>a1</id></entry></feed>');
  assert.equal(atom[0].url, 'https://x.test/2');
  assert.equal(atom[0].key, 'a1');
});

test('a JSON search API is read through configurable paths', () => {
  const body = JSON.stringify({ results: [{ sku: 'A1', title: 'RTX 5090 FE', url: '/p/a1' }] });
  const items = parseSearch(
    { body, page: createPage({ url: 'https://s.test/api', status: 200, body }) },
    { url: 'https://s.test/api/search', itemsPath: 'results[]', urlPath: 'url', titlePath: 'title', idPath: 'sku' },
  );
  assert.equal(items[0].key, 'A1');
  assert.equal(items[0].url, 'https://s.test/p/a1', 'relative URLs are resolved');
});

test('an HTML search page falls back to link scraping', () => {
  const body = '<html><body><a href="/p/one">Widget One</a><a href="/p/two">Widget Two</a></body></html>';
  const items = parseSearch({ body, url: 'https://s.test/search', page: createPage({ url: 'https://s.test/search', status: 200, body }) }, { url: 'https://s.test/search' });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://s.test/p/one');
});

test('keyword matching supports plain terms, regex terms and exclusions', () => {
  const src = { keywords: ['/rtx.?5090/', 'founders'] };
  assert.equal(matchesKeywords('RTX-5090 card', src), true);
  assert.equal(matchesKeywords('Founders Edition', src), true);
  assert.equal(matchesKeywords('RTX 4090', src), false);

  assert.equal(matchesKeywords('rtx 5090 bundle', { ...src, exclude: ['bundle'] }), false);
  assert.equal(matchesKeywords('rtx 5090', { keywords: ['5090', 'founders'], matchAll: true }), false);
  assert.equal(matchesKeywords('rtx 5090 founders', { keywords: ['5090', 'founders'], matchAll: true }), true);
});

test('an invalid regex keyword is ignored rather than throwing', () => {
  assert.equal(matchesKeywords('anything', { keywords: ['/[unclosed/'] }), false);
});

test('a discovery hit becomes a watch target that inherits the template', () => {
  const target = targetFromDiscovery(
    { url: 'https://s.test/p/x', title: 'RTX 5090', key: 'k1' },
    { id: 'src', watchTemplate: { intervalMs: 5000, maxPrice: 2199 } },
  );
  assert.equal(target.url, 'https://s.test/p/x');
  assert.equal(target.intervalMs, 5000);
  assert.equal(target.maxPrice, 2199);
  assert.match(target.id, /^src-/);
});

test('only genuinely new listings are reported on a second scan', async () => {
  const xml = `<urlset><url><loc>https://s.test/p/rtx-5090</loc></url></urlset>`;
  const source = { id: 'sm', kind: 'sitemap', url: 'https://s.test/sitemap.xml', keywords: ['5090'] };
  const fetcher = { get: async () => ({ status: 200, body: xml, url: source.url }) };
  const store = new Store('/dev/null');

  const first = await runDiscovery(source, { fetcher, store });
  assert.equal(first.items.length, 1);

  const second = await runDiscovery(source, { fetcher, store });
  assert.equal(second.items.length, 0, 'already-seen listings must not re-alert');
  assert.equal(second.matched, 1);
});

test('the seen-list is capped so a huge sitemap cannot grow state without bound', () => {
  const store = new Store('/dev/null');
  store.markSeen('big', Array.from({ length: 6000 }, (_, i) => `k${i}`));
  assert.equal(store.discovery('big').seen.length, 5000);
});
