import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStore, tempDir, recorder } from './helpers.js';
import { Fetcher } from '../src/fetcher.js';
import { Store } from '../src/state.js';
import { Watcher } from '../src/scheduler.js';
import { DEFAULTS } from '../src/config.js';

async function harness(target = {}, { serverOpts, defaults } = {}) {
  const store = await startStore(serverOpts);
  const tmp = await tempDir();
  const persisted = await new Store(tmp.file).load();
  const notifier = recorder();

  const config = {
    defaults: { ...DEFAULTS, minHostGapMs: 0, ...defaults },
    targets: [],
    discovery: [],
  };
  const watcher = new Watcher({
    config,
    fetcher: new Fetcher({ minHostGapMs: 0, maxRetries: 0, timeoutMs: 5000 }),
    notifier,
    store: persisted,
  });

  const full = {
    id: 'widget',
    name: 'Widget',
    url: store.url('/p'),
    enabled: true,
    ...DEFAULTS,
    ...target,
  };

  return {
    store,
    persisted,
    notifier,
    watcher,
    target: full,
    stateFile: tmp.file,
    check: () => watcher.checkTarget(full),
    async cleanup() {
      await store.close();
      await tmp.cleanup();
    },
  };
}

test('walks the ladder and alerts once per forward step, with escalating urgency', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.state = 'absent';
  assert.equal((await h.check()).state, 'absent');
  assert.equal(h.notifier.sent.length, 0, 'a missing page is not news');

  h.store.ctx.state = 'coming_soon';
  let result = await h.check();
  assert.equal(result.state, 'coming_soon');
  assert.equal(result.urgency, 'default');
  assert.equal(h.notifier.sent.length, 1);
  assert.match(h.notifier.sent[0].title, /HEADS UP/);
  assert.match(h.notifier.sent[0].body, /early warning/i);

  h.store.ctx.state = 'in_stock';
  result = await h.check();
  assert.equal(result.state, 'in_stock');
  assert.equal(result.urgency, 'max');
  assert.equal(h.notifier.sent.length, 2);
  assert.match(h.notifier.sent[1].title, /^IN STOCK/);
  assert.equal(h.notifier.sent[1].price, 499);

  // Staying in stock must not re-alert every poll.
  await h.check();
  assert.equal(h.notifier.sent.length, 2, 'no repeat alert while state holds');

  // Selling out is recorded quietly so the next restock alerts again.
  h.store.ctx.state = 'out_of_stock';
  await h.check();
  assert.equal(h.notifier.sent.length, 2);
  h.store.ctx.state = 'in_stock';
  h.store.ctx.price = '498.00'; // change the body so the etag differs
  await h.check();
  assert.equal(h.notifier.sent.length, 3, 'a restock after a sell-out is news again');
});

test('a 304 response short-circuits without re-alerting or reparsing', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  await h.check();
  assert.equal(h.notifier.sent.length, 1);

  const result = await h.check();
  assert.equal(result.outcome, 'unchanged');
  assert.ok(h.store.ctx.conditionalHits >= 1, 'the second poll sent If-None-Match');
  assert.equal(h.notifier.sent.length, 1);
});

test('the price guard blocks an alert for a listing above your max', async (t) => {
  const h = await harness({ maxPrice: 100 });
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock'; // priced 499
  const result = await h.check();
  assert.equal(result.outcome, 'suppressed');
  assert.match(result.reason, /over your max/);
  assert.equal(h.notifier.sent.length, 0);
});

test('alertOverPrice opts back in to alerts above the max', async (t) => {
  const h = await harness({ maxPrice: 100, alertOverPrice: true });
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  assert.equal((await h.check()).outcome, 'alert');
  assert.equal(h.notifier.sent.length, 1);
});

test('robots.txt disallow blocks the fetch and says so', async (t) => {
  const h = await harness({}, { serverOpts: { robots: 'User-agent: *\nDisallow: /p\n' } });
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  const before = h.store.ctx.hits;
  const result = await h.check();
  assert.equal(result.outcome, 'blocked');
  assert.equal(h.store.ctx.hits, before, 'the product page was never requested');
  assert.equal(h.notifier.sent.length, 0);
});

test('a per-target respectRobots override is honoured', async (t) => {
  const h = await harness({ respectRobots: false }, { serverOpts: { robots: 'User-agent: *\nDisallow: /\n' } });
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  assert.equal((await h.check()).outcome, 'alert');
});

test('a 429 pauses the host instead of hammering it', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.status = 429;
  assert.equal((await h.check()).outcome, 'throttled');

  const after = h.store.ctx.hits;
  const second = await h.check();
  assert.equal(second.outcome, 'skipped', 'the host stays paused');
  assert.equal(h.store.ctx.hits, after, 'no request was sent while backing off');
});

test('state survives a restart, so a reboot does not replay old alerts', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  await h.check();
  assert.equal(h.notifier.sent.length, 1);
  await h.persisted.flush(true);

  const reloaded = await new Store(h.stateFile).load();
  const notifier = recorder();
  const fresh = new Watcher({
    config: { defaults: { ...DEFAULTS, minHostGapMs: 0 }, targets: [], discovery: [] },
    fetcher: new Fetcher({ minHostGapMs: 0, maxRetries: 0 }),
    notifier,
    store: reloaded,
  });

  assert.equal(reloaded.target('widget').state, 'in_stock');
  await fresh.checkTarget(h.target);
  assert.equal(notifier.sent.length, 0, 'a restart on an unchanged page stays quiet');
});

test('a full run() pass checks every target and then exits', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  h.watcher.targets = [h.target];
  const stats = await h.watcher.run({ maxCycles: 1, tickMs: 1 });

  assert.equal(stats.checks, 1);
  assert.equal(stats.alerts, 1);
  assert.equal(stats.errors, 0);
  assert.equal(h.notifier.sent.length, 1);
});

test('a dead URL is recorded as a failure rather than crashing the loop', async (t) => {
  const h = await harness({ url: 'http://127.0.0.1:1/nothing' });
  t.after(() => h.cleanup());

  const result = await h.check();
  assert.equal(result.outcome, 'error');
  assert.equal(h.persisted.target('widget').failures, 1);
  assert.equal(h.notifier.sent.length, 0);
});

test('alertOnChange reports a content shift that did not move the state', async (t) => {
  const h = await harness({ alertOnChange: true, cooldownMs: 60_000 });
  t.after(() => h.cleanup());

  h.store.ctx.state = 'coming_soon';
  await h.check();
  assert.equal(h.notifier.sent.length, 1, 'the coming_soon transition itself');

  // A new etag over byte-identical content is not a change worth reporting.
  h.store.ctx.price = '399.00'; // moves the etag; coming_soon body omits price
  assert.equal((await h.check()).outcome, 'ok');
  assert.equal(h.notifier.sent.length, 1);

  h.store.ctx.state = 'in_stock';
  await h.check();
  assert.equal(h.notifier.sent.length, 2, 'the in_stock transition');

  // Same state, genuinely different bytes — the page is being edited.
  h.store.ctx.price = '349.00'; // the in_stock body embeds the price
  assert.equal((await h.check()).outcome, 'changed');

  const changeAlerts = h.notifier.sent.filter((a) => a.title.startsWith('Page changed'));
  assert.equal(changeAlerts.length, 1);
  assert.equal(changeAlerts[0].urgency, 'low');

  // The long cooldown damps these, since page bytes move constantly.
  h.store.ctx.price = '344.00';
  await h.check();
  assert.equal(h.notifier.sent.filter((a) => a.title.startsWith('Page changed')).length, 1);
});

test('alertOnChange is off unless asked for', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.ctx.state = 'in_stock';
  await h.check();
  h.store.ctx.price = '399.00';
  const result = await h.check();
  assert.equal(result.outcome, 'ok');
  assert.equal(h.notifier.sent.filter((a) => a.title.startsWith('Page changed')).length, 0);
});
