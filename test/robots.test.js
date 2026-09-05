import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, matchPath, RobotsCache } from '../src/robots.js';

const allowed = (txt, path, ua = 'scalper-bot') => {
  const rules = parseRobots(txt, ua);
  return rules ? matchPath(rules, path).allowed : true;
};

test('longest match wins and Allow beats Disallow at equal length', () => {
  const txt = 'User-agent: *\nDisallow: /checkout\nAllow: /checkout/public\n';
  assert.equal(allowed(txt, '/product/1'), true);
  assert.equal(allowed(txt, '/checkout/cart'), false);
  assert.equal(allowed(txt, '/checkout/public/x'), true);
});

test('an exact user-agent group overrides the wildcard group', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: scalper-bot\nDisallow: /admin\n';
  assert.equal(allowed(txt, '/product'), true);
  assert.equal(allowed(txt, '/admin/panel'), false);
});

test('consecutive user-agent lines share one rule group', () => {
  const txt = 'User-agent: a\nUser-agent: scalper-bot\nDisallow: /nope\n';
  assert.equal(allowed(txt, '/nope'), false);
  assert.equal(allowed(txt, '/yes'), true);
});

test('wildcards and end-anchors in paths are honoured', () => {
  const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n';
  assert.equal(allowed(txt, '/docs/manual.pdf'), false);
  assert.equal(allowed(txt, '/docs/manual.pdf?x=1'), true, 'the $ anchors the end');
  assert.equal(allowed(txt, '/a/anything/b'), false);
});

test('an empty Disallow means everything is allowed', () => {
  assert.equal(allowed('User-agent: *\nDisallow:\n', '/anything'), true);
});

test('comments and blank lines do not confuse the parser', () => {
  const txt = '# hello\nUser-agent: *   # everyone\nDisallow: /x  # nope\n\n';
  assert.equal(allowed(txt, '/x'), false);
  assert.equal(allowed(txt, '/y'), true);
});

test('crawl-delay is surfaced so the fetcher can slow down for that host', () => {
  const rules = parseRobots('User-agent: *\nCrawl-delay: 5\nDisallow: /x\n', 'scalper-bot');
  assert.equal(matchPath(rules, '/x').crawlDelay, 5);
});

test('an unreachable robots.txt fails open rather than blocking the watch', async () => {
  const cache = new RobotsCache({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal((await cache.isAllowed('https://x.test/p')).allowed, true);
});

test('robots.txt is fetched once per host and then cached', async () => {
  let hits = 0;
  const cache = new RobotsCache({
    fetchImpl: async () => {
      hits += 1;
      return { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /no\n' };
    },
  });
  assert.equal((await cache.isAllowed('https://x.test/no')).allowed, false);
  assert.equal((await cache.isAllowed('https://x.test/yes')).allowed, true);
  assert.equal(hits, 1, 'the second check reused the cached rules');
});
