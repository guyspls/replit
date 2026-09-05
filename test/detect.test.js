import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPage } from '../src/extract.js';
import { detectState, detectPrice, classifyTransition, rank, isBuyable, STATES } from '../src/detect.js';

const page = (body, status = 200) => createPage({ url: 'https://x/p', status, body: `<html><body>${body}</body></html>` });
const stateOf = (body, target) => detectState(page(body), target).state;

test('the default heuristics classify ordinary storefront wording', () => {
  const cases = [
    ['<button>Add to Cart</button>', 'in_stock'],
    ['<button>Add to basket</button>', 'in_stock'],
    ['<button>Buy it now</button>', 'in_stock'],
    ['<button>Add to bag</button><span>Only 3 left</span>', 'low_stock'],
    ['<div>Pre-order now</div>', 'preorder'],
    ['<div>Coming soon</div>', 'coming_soon'],
    ['<button>Notify me when available</button>', 'coming_soon'],
    ['<div>Sold out</div>', 'unknown'],
    ['<div>Currently unavailable</div>', 'unknown'],
    ['<p>Just a page about widgets.</p>', 'unknown'],
  ];
  for (const [html, expected] of cases) {
    assert.equal(stateOf(html), expected, `${html} should read as ${expected}`);
  }
});

test('schema.org availability is trusted over page prose', () => {
  const ld = (avail) => `<script type="application/ld+json">{"offers":{"availability":"${avail}"}}</script>`;
  assert.equal(stateOf(ld('https://schema.org/InStock')), 'in_stock');
  assert.equal(stateOf(ld('https://schema.org/PreOrder')), 'preorder');
  assert.equal(stateOf(ld('https://schema.org/OutOfStock')), 'unknown');
  assert.equal(stateOf(ld('https://schema.org/LimitedAvailability')), 'low_stock');
});

test('a positive buy signal outranks a stray sold-out string', () => {
  // Storefronts routinely ship "Sold out" markup for sibling variants.
  assert.equal(stateOf('<button>Add to cart</button><span class="v">Sold out</span>'), 'in_stock');
});

test('out-of-stock vetoes preorder but leaves the coming-soon early warning intact', () => {
  assert.equal(stateOf('<div>Pre-order</div><div>Out of stock</div>'), 'unknown');
  assert.equal(stateOf('<div>Coming soon</div><div>Out of stock</div>'), 'coming_soon');
});

test('HTTP status maps to absent or a degraded unknown', () => {
  assert.equal(detectState(page('', 404)).state, 'absent');
  assert.equal(detectState(page('', 410)).state, 'absent');
  const err = detectState(page('', 500));
  assert.equal(err.state, 'unknown');
  assert.equal(err.degraded, true);
});

test('custom signals override one bucket without discarding the others', () => {
  const target = { signals: { in_stock: [{ type: 'selector', selector: '#buy', op: 'exists' }] } };
  assert.equal(stateOf('<div id="buy"></div>', target), 'in_stock');
  // The stock default said "add to cart" is in stock; the override replaces it.
  assert.equal(stateOf('<button>Add to cart</button>', target), 'unknown');
  // ...while the untouched coming_soon defaults still apply.
  assert.equal(stateOf('<div>Coming soon</div>', target), 'coming_soon');
});

test('replaceDefaults strips every bucket the target does not define', () => {
  const target = { signals: { replaceDefaults: true, in_stock: [{ type: 'text', op: 'contains', value: 'yes buy' }] } };
  assert.equal(stateOf('<div>Coming soon</div>', target), 'unknown');
  assert.equal(stateOf('<div>yes buy</div>', target), 'in_stock');
});

test('operators cover the comparisons a real rule needs', () => {
  const t = (rule, html = '<div id="x" data-qty="4">Hello</div>') => stateOf(html, { signals: { in_stock: [rule] } });
  assert.equal(t({ type: 'selector', selector: '#x', op: 'exists' }), 'in_stock');
  assert.equal(t({ type: 'selector', selector: '#nope', op: 'missing' }), 'in_stock');
  assert.equal(t({ type: 'selector', selector: '#x', attr: 'data-qty', op: 'gt', value: 0 }), 'in_stock');
  assert.equal(t({ type: 'selector', selector: '#x', attr: 'data-qty', op: 'lt', value: 1 }), 'unknown');
  assert.equal(t({ type: 'text', op: 'matches', value: 'hel+o' }), 'in_stock');
  assert.equal(t({ type: 'text', op: 'not_contains', value: 'goodbye' }), 'in_stock');
  assert.equal(t({ type: 'status', op: 'equals', value: 200 }), 'in_stock');
});

test('a rule with a bad selector degrades to no-match instead of crashing', () => {
  const result = detectState(page('<div>x</div>'), { signals: { in_stock: [{ type: 'bogus' }] } });
  assert.equal(result.state, 'unknown');
  assert.ok(result.reasons.some((r) => r.includes('rule error')));
});

test('detectPrice finds a price across the common markup conventions', () => {
  assert.equal(detectPrice(page('<script type="application/ld+json">{"offers":{"price":"1299.00"}}</script>')), 1299);
  assert.equal(detectPrice(page('<span itemprop="price" content="49.99">£49.99</span>')), 49.99);
  assert.equal(detectPrice(page('<div data-price="24.50"></div>')), 24.5);
  assert.equal(detectPrice(page('<meta property="product:price:amount" content="7.00">')), 7);
  assert.equal(detectPrice(page('<p>no price here</p>')), null);
});

test('the state ladder orders early warnings below buyable', () => {
  assert.ok(rank('absent') < rank('coming_soon'));
  assert.ok(rank('coming_soon') < rank('preorder'));
  assert.ok(rank('preorder') < rank('in_stock'));
  assert.equal(rank('nonsense'), STATES.unknown);
  assert.ok(isBuyable('in_stock') && isBuyable('preorder') && isBuyable('low_stock'));
  assert.ok(!isBuyable('coming_soon') && !isBuyable('absent'));
});

test('only forward movement alerts, and urgency scales with how buyable it is', () => {
  assert.deepEqual(classifyTransition('absent', 'coming_soon'), { alert: true, kind: 'early-warning', urgency: 'default' });
  assert.deepEqual(classifyTransition('coming_soon', 'preorder'), { alert: true, kind: 'buyable', urgency: 'high' });
  assert.deepEqual(classifyTransition('coming_soon', 'in_stock'), { alert: true, kind: 'buyable', urgency: 'max' });
  assert.equal(classifyTransition('in_stock', 'unknown').alert, false);
  assert.equal(classifyTransition('in_stock', 'in_stock').alert, false);
  // A cold start that lands straight on in_stock still has to wake you up.
  assert.equal(classifyTransition(null, 'in_stock').alert, true);
  // ...but a cold start on a page with no signal must not.
  assert.equal(classifyTransition(null, 'unknown').alert, false);
  assert.equal(classifyTransition(null, 'absent').alert, false);
});
