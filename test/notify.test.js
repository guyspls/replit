import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, AlertGate, buildAlert, formatPrice, CHANNELS } from '../src/notify/index.js';

const okFetch = (calls) => async (url, opts) => {
  calls.push({ url, body: opts.body, headers: opts.headers });
  return { ok: true, status: 200, text: async () => '' };
};

test('only fully configured channels are activated', () => {
  const n = new Notifier({ ntfy: { topic: 't' }, telegram: { botToken: 'x' }, desktop: false });
  assert.deepEqual(n.channelNames, ['ntfy']); // telegram is missing chatId
});

test('desktop is on by default and can be switched off', () => {
  assert.ok(new Notifier({}).channelNames.includes('desktop'));
  assert.ok(!new Notifier({ desktop: false }).channelNames.includes('desktop'));
});

test('every channel fires in parallel and one failure cannot block the rest', async () => {
  const calls = [];
  const flaky = async (url, opts) => {
    if (url.includes('discord')) throw new Error('socket hang up');
    return okFetch(calls)(url, opts);
  };
  const n = new Notifier(
    { ntfy: { topic: 't' }, discord: { webhookUrl: 'https://discord/x' }, slack: { webhookUrl: 'https://slack/y' }, desktop: false },
    { fetchImpl: flaky },
  );
  const result = await n.send({ title: 'IN STOCK', body: 'go', url: 'https://shop/p', urgency: 'max', tags: [] });

  assert.deepEqual(result.delivered.sort(), ['ntfy', 'slack']);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /^discord: socket hang up/);
});

test('a non-2xx channel response is reported, not swallowed', async () => {
  const n = new Notifier({ ntfy: { topic: 't' }, desktop: false }, {
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
  });
  const result = await n.send({ title: 't', body: 'b', tags: [] });
  assert.equal(result.delivered.length, 0);
  assert.match(result.failed[0], /ntfy HTTP 403/);
});

test('ntfy carries urgency, a click target and a tap-through action', async () => {
  const calls = [];
  const n = new Notifier({ ntfy: { topic: 'my topic' }, desktop: false }, { fetchImpl: okFetch(calls) });
  await n.send({ title: 'IN STOCK', body: 'go', url: 'https://shop/p', urgency: 'max', tags: ['x'] });

  assert.equal(calls[0].url, 'https://ntfy.sh/my%20topic');
  assert.equal(calls[0].headers.Priority, '5');
  assert.equal(calls[0].headers.Click, 'https://shop/p');
  assert.match(calls[0].headers.Actions, /view, Open listing, https:\/\/shop\/p/);
});

test('no configured channel still reports rather than pretending to deliver', async () => {
  const n = new Notifier({ desktop: false });
  assert.deepEqual(await n.send({ title: 't', body: 'b', tags: [] }), { delivered: [], failed: [] });
});

test('every registered channel exposes the same interface', () => {
  for (const c of CHANNELS) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.configured, 'function');
    assert.equal(typeof c.send, 'function');
  }
});

test('the gate lets genuine repeats through but caps a flapping page', () => {
  let clock = 0;
  const gate = new AlertGate({ maxPerWindow: 3, windowMs: 1000, now: () => clock });
  const record = {};

  for (let i = 0; i < 3; i += 1) {
    assert.equal(gate.shouldSend(record, 'in_stock'), true, `alert ${i + 1} should pass`);
    gate.mark(record, 'in_stock');
    clock += 10;
  }
  assert.equal(gate.shouldSend(record, 'in_stock'), false, 'the fourth in one window is flapping');

  // A different event is unaffected by another key's ceiling.
  assert.equal(gate.shouldSend(record, 'coming_soon'), true);

  // Once the window rolls past, the target is heard from again.
  clock += 1000;
  assert.equal(gate.shouldSend(record, 'in_stock'), true);
});

test('the gate bounds what it stores so long watches cannot grow forever', () => {
  const gate = new AlertGate({ now: () => Date.now() });
  const record = {};
  for (let i = 0; i < 40; i += 1) gate.mark(record, `key-${i}`);
  assert.equal(Object.keys(record.alertLog).length, 20);
  for (let i = 0; i < 30; i += 1) gate.mark(record, 'hot');
  assert.equal(record.alertLog.hot.length, 10);
});

test('alert copy names the transition and respects the max-price context', () => {
  const alert = buildAlert({
    target: { id: 'gpu', name: 'GPU', url: 'https://s/p', maxPrice: 2000, currency: 'USD' },
    state: 'in_stock',
    previous: 'coming_soon',
    price: 1999,
    urgency: 'max',
    kind: 'buyable',
    reasons: ['jsonld availability matches InStock'],
  });
  assert.equal(alert.title, 'IN STOCK: GPU');
  assert.match(alert.body, /coming_soon -> in_stock/);
  assert.match(alert.body, /\$1,999\.00/);
  assert.equal(alert.url, 'https://s/p');

  const early = buildAlert({ target: { id: 'g', name: 'G', url: 'u' }, state: 'coming_soon', previous: 'absent', urgency: 'default', kind: 'early-warning' });
  assert.match(early.title, /HEADS UP/);
  assert.match(early.body, /Not buyable yet/);
});

test('buyUrl overrides the watch URL so the alert links straight to checkout', () => {
  const alert = buildAlert({ target: { id: 'g', name: 'G', url: 'https://s/p', buyUrl: 'https://s/cart/add?sku=1' }, state: 'in_stock', previous: 'unknown', urgency: 'max', kind: 'buyable' });
  assert.equal(alert.url, 'https://s/cart/add?sku=1');
});

test('price formatting falls back instead of throwing on a bad currency', () => {
  assert.equal(formatPrice(12.5, 'USD'), '$12.50');
  assert.equal(formatPrice(12.5, 'NOTACURRENCY'), '12.5 NOTACURRENCY');
});
