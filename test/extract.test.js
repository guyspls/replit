import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPage, parsePrice, getPath, resolveSource } from '../src/extract.js';

const page = (body, extra = {}) => createPage({ url: 'https://x/p', status: 200, body, ...extra });

test('parsePrice handles the formats real storefronts emit', () => {
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice('USD 34.50'), 34.5);
  assert.equal(parsePrice('1.299,99 €'), 1299.99);
  assert.equal(parsePrice('£12.99'), 12.99);
  assert.equal(parsePrice('2,50'), 2.5);
  assert.equal(parsePrice('1 299,00'), 1299);
  assert.equal(parsePrice(499), 499);
  assert.equal(parsePrice('out of stock'), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice(Number.NaN), null);
});

test('parsePrice reads a 3-digit tail as thousands, not millidollars', () => {
  // Retail never quotes 3 decimals, so "1.234" is 1234 (European grouping).
  assert.equal(parsePrice('1.234'), 1234);
  assert.equal(parsePrice('1,234'), 1234);
});

test('text extraction inserts boundaries between adjacent elements', () => {
  // Minified markup must not fuse into "Add to cartSold out", which would
  // silently defeat every \b-anchored phrase rule.
  const p = page('<html><body><button>Add to cart</button><span>Sold out</span></body></html>');
  assert.match(p.text, /add to cart sold out/i);
});

test('reading text does not destroy JSON-LD for later rules', () => {
  const p = page(
    '<html><body><p>hi</p><script type="application/ld+json">{"offers":{"availability":"InStock","price":"9.99"}}</script></body></html>',
  );
  assert.equal(p.text, 'hi');
  assert.deepEqual(resolveSource(p, { type: 'jsonld', path: 'availability' }).values, ['InStock']);
  assert.equal(p.text, 'hi'); // memoized, still correct
  assert.deepEqual(resolveSource(p, { type: 'jsonld', path: 'price' }).values, ['9.99']);
});

test('JSON-LD flattens @graph and offers, and survives a malformed sibling block', () => {
  const p = page(`<html><body>
    <script type="application/ld+json">{ not json at all }</script>
    <script type="application/ld+json">{"@graph":[{"@type":"Product","offers":{"availability":"https://schema.org/PreOrder"}}]}</script>
  </body></html>`);
  assert.deepEqual(resolveSource(p, { type: 'jsonld', path: 'availability' }).values, ['https://schema.org/PreOrder']);
});

test('getPath walks dots, indexes and [] wildcards', () => {
  const obj = { product: { variants: [{ available: false }, { available: true }] }, list: [1, 2] };
  assert.equal(getPath(obj, 'product.variants.1.available'), true);
  assert.deepEqual(getPath(obj, 'product.variants[].available'), [false, true]);
  assert.equal(getPath(obj, 'nope.deep.path'), undefined);
  assert.deepEqual(getPath(obj, ''), obj);
});

test('selector source distinguishes missing from present-but-empty', () => {
  const p = page('<html><body><div class="a"></div><b data-x="7">hi</b></body></html>');
  assert.deepEqual(resolveSource(p, { type: 'selector', selector: '.a' }), { found: true, values: [''] });
  assert.deepEqual(resolveSource(p, { type: 'selector', selector: '.missing' }), { found: false, values: [] });
  assert.deepEqual(resolveSource(p, { type: 'selector', selector: 'b', attr: 'data-x' }).values, ['7']);
});

test('json source only parses actual JSON bodies', () => {
  assert.equal(page('<html></html>').json, null);
  assert.deepEqual(page('{"a":{"b":2}}').json, { a: { b: 2 } });
  assert.deepEqual(resolveSource(page('{"a":{"b":2}}'), { type: 'json', path: 'a.b' }).values, [2]);
});

test('header lookups are case-insensitive on the normalized object', () => {
  const p = page('x', { headers: { etag: '"abc"' } });
  assert.deepEqual(resolveSource(p, { type: 'header', name: 'ETag' }).values, ['"abc"']);
  assert.equal(resolveSource(p, { type: 'header', name: 'missing' }).found, false);
});
