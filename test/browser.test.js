import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutablePath } from '../src/browser.js';
import { Fetcher } from '../src/fetcher.js';
import { detectState } from '../src/detect.js';

const havePlaywright = await import('playwright').then(() => true, () => false);

test('the chromium lookup prefers a full build over the headless shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-'));
  for (const dir of ['chromium-1194', 'chromium_headless_shell-1194']) {
    mkdirSync(join(root, dir, 'chrome-linux'), { recursive: true });
  }
  writeFileSync(join(root, 'chromium_headless_shell-1194', 'chrome-linux', 'headless_shell'), '');
  assert.match(resolveExecutablePath(root), /headless_shell$/, 'the shell is used when it is all there is');

  writeFileSync(join(root, 'chromium-1194', 'chrome-linux', 'chrome'), '');
  assert.match(resolveExecutablePath(root), /chromium-1194\/chrome-linux\/chrome$/);
});

test('an explicit override wins over any discovered build', () => {
  process.env.PLAYWRIGHT_CHROMIUM_PATH = '/custom/chrome';
  try {
    assert.equal(resolveExecutablePath('/opt/pw-browsers'), '/custom/chrome');
  } finally {
    delete process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
});

test('a missing browser root is reported as "not found", not a crash', () => {
  assert.equal(resolveExecutablePath('/no/such/dir'), null);
  assert.equal(resolveExecutablePath(null), null, 'no root configured at all');
  // With no root and no override, Playwright falls back to its own lookup,
  // which is the right behaviour on an ordinary machine.
});

test('browser mode reads stock that only exists after JavaScript runs', { skip: !havePlaywright }, async (t) => {
  // A storefront whose served HTML says nothing about stock — the shape that
  // defeats a plain HTTP poll at every large retailer.
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>
      <h1>Console</h1><div id="fulfillment">Loading…</div>
      <script>setTimeout(() => {
        document.getElementById('fulfillment').innerHTML =
          '<button data-test="add-to-cart">Add to Cart</button>' +
          '<script type="application/ld+json">{"offers":{"availability":"https://schema.org/InStock","price":"699.99"}}<\\/script>';
      }, 250);<\/script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/p`;

  const fetcher = new Fetcher({ minHostGapMs: 0, timeoutMs: 30_000 });
  t.after(async () => {
    await fetcher.close();
    await new Promise((r) => server.close(r));
  });

  const plain = await fetcher.get(url);
  assert.equal(detectState(plain.page).state, 'unknown', 'the served HTML alone gives nothing away');

  const rendered = await fetcher.get(url, { mode: 'browser', browser: { waitFor: '[data-test=add-to-cart]' } });
  assert.equal(rendered.rendered, true);
  assert.equal(rendered.status, 200);
  assert.equal(detectState(rendered.page).state, 'in_stock');
});

test('browser mode still answers robots.txt before it launches anything', { skip: !havePlaywright }, async (t) => {
  let productHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /p\n');
    }
    productHits += 1;
    res.writeHead(200).end('<html><body><button>Add to cart</button></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/p`;

  const fetcher = new Fetcher({ minHostGapMs: 0 });
  t.after(async () => {
    await fetcher.close();
    await new Promise((r) => server.close(r));
  });

  const res = await fetcher.get(url, { mode: 'browser' });
  assert.equal(res.blockedByRobots, true);
  assert.equal(productHits, 0, 'rendering must not be a way around robots.txt');
});

test('a browser failure is returned as an error, not thrown at the loop', { skip: !havePlaywright }, async (t) => {
  const fetcher = new Fetcher({ minHostGapMs: 0, timeoutMs: 2000 });
  t.after(() => fetcher.close());

  const res = await fetcher.get('http://127.0.0.1:1/dead', { mode: 'browser' });
  assert.match(res.error, /^browser: /);
});

test('close() is safe to call when no browser was ever started', async () => {
  const fetcher = new Fetcher();
  await fetcher.close();
  await fetcher.close();
});
