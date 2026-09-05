import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, slug, expandEnv, MissingEnvError, DEFAULTS } from '../src/config.js';
import { parseArgs } from '../src/index.js';
import { tempDir } from './helpers.js';

async function withConfig(doc, fn) {
  const tmp = await tempDir();
  const file = join(tmp.dir, 'watchlist.json');
  await writeFile(file, JSON.stringify(doc));
  try {
    return await fn(file);
  } finally {
    await tmp.cleanup();
  }
}

const minimal = { targets: [{ id: 'a', url: 'https://s.test/p' }] };

test('targets inherit defaults and get sane derived fields', async () => {
  await withConfig(minimal, async (file) => {
    const cfg = await loadConfig(file);
    const t = cfg.targets[0];
    assert.equal(t.name, 'a');
    assert.equal(t.enabled, true);
    assert.equal(t.intervalMs, DEFAULTS.intervalMs);
    assert.equal(t.respectRobots, true);
    assert.equal(t.maxPrice, null);
    assert.equal(t.dropAt, null);
  });
});

test('per-target settings win over defaults', async () => {
  await withConfig(
    { defaults: { intervalMs: 5000 }, targets: [{ id: 'a', url: 'https://s.test/p', intervalMs: 9000, respectRobots: false }] },
    async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.targets[0].intervalMs, 9000);
      assert.equal(cfg.targets[0].respectRobots, false);
      assert.equal(cfg.defaults.intervalMs, 5000);
    },
  );
});

test('polling faster than the floor is clamped rather than accepted', async () => {
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p', intervalMs: 5, hotIntervalMs: 1 }] }, async (file) => {
    const cfg = await loadConfig(file);
    assert.equal(cfg.targets[0].intervalMs, 1000);
    assert.equal(cfg.targets[0].hotIntervalMs, 1000);
  });
});

test('dropAt is parsed to a timestamp and rejected when malformed', async () => {
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p', dropAt: '2026-09-12T14:00:00Z' }] }, async (file) => {
    const cfg = await loadConfig(file);
    assert.equal(cfg.targets[0].dropAt, Date.parse('2026-09-12T14:00:00Z'));
  });
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p', dropAt: 'next tuesday' }] }, async (file) => {
    await assert.rejects(() => loadConfig(file), /not a valid date/);
  });
});

test('bad input is rejected with a message that names the problem', async () => {
  await withConfig({ targets: [{ id: 'a' }] }, (f) => assert.rejects(() => loadConfig(f), /"url" is required/));
  await withConfig({ targets: [{ id: 'a', url: 'not-a-url' }] }, (f) => assert.rejects(() => loadConfig(f), /not a valid URL/));
  await withConfig({ targets: [{ id: 'a', url: 'file:///etc/passwd' }] }, (f) => assert.rejects(() => loadConfig(f), /only http\(s\)/));
  await withConfig({ targets: [] }, (f) => assert.rejects(() => loadConfig(f), /no targets and no discovery/));
  await withConfig(
    { targets: [{ id: 'dup', url: 'https://s.test/1' }, { id: 'dup', url: 'https://s.test/2' }] },
    (f) => assert.rejects(() => loadConfig(f), /duplicate id/),
  );
});

test('discovery sources are validated too', async () => {
  await withConfig({ discovery: [{ id: 'd', kind: 'nope', url: 'https://s.test/s.xml', keywords: ['x'] }] }, (f) =>
    assert.rejects(() => loadConfig(f), /"kind" must be one of/),
  );
  await withConfig({ discovery: [{ id: 'd', kind: 'sitemap', url: 'https://s.test/s.xml' }] }, (f) =>
    assert.rejects(() => loadConfig(f), /"keywords" must be a non-empty array/),
  );
  await withConfig({ discovery: [{ id: 'd', kind: 'search', url: 'https://s.test/q?s={query}', keywords: ['x'] }] }, async (f) => {
    const cfg = await loadConfig(f); // the {query} placeholder must not fail URL validation
    assert.equal(cfg.discovery[0].enabled, true);
  });
});

test('a missing watchlist explains how to create one', async () => {
  await assert.rejects(() => loadConfig('/nonexistent/watchlist.json'), /watchlist.example.json/);
});

test('malformed JSON points at the file rather than dumping a stack', async () => {
  const tmp = await tempDir();
  const file = join(tmp.dir, 'bad.json');
  await writeFile(file, '{ nope ');
  await assert.rejects(() => loadConfig(file), /is not valid JSON/);
  await tmp.cleanup();
});

test('secrets are read from the environment, never required in the file', async () => {
  process.env.NTFY_TOPIC = 'env-topic';
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
  try {
    await withConfig(minimal, async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.notifications.ntfy.topic, 'env-topic');
      assert.equal(cfg.notifications.discord.webhookUrl, 'https://discord.test/hook');
    });
  } finally {
    delete process.env.NTFY_TOPIC;
    delete process.env.DISCORD_WEBHOOK_URL;
  }
});

test('an explicit value in the file beats the environment', async () => {
  process.env.NTFY_TOPIC = 'env-topic';
  try {
    await withConfig({ ...minimal, notifications: { ntfy: { topic: 'file-topic' } } }, async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.notifications.ntfy.topic, 'file-topic');
    });
  } finally {
    delete process.env.NTFY_TOPIC;
  }
});

test('slug produces stable ids from messy names', () => {
  assert.equal(slug('RTX 5090 -- Founders Edition!'), 'rtx-5090-founders-edition');
  assert.equal(slug('///'), 'target');
  assert.equal(slug('a'.repeat(200)).length, 60);
});

test('the CLI argument parser handles flags, values and inline forms', () => {
  assert.deepEqual(parseArgs(['check', 'gpu', '--log', 'debug']), { _: ['check', 'gpu'], flags: { log: 'debug' } });
  assert.deepEqual(parseArgs(['watch', '--once']), { _: ['watch'], flags: { once: true } });
  assert.deepEqual(parseArgs(['--config=/tmp/w.json']), { _: [], flags: { config: '/tmp/w.json' } });
  assert.deepEqual(parseArgs(['add', 'https://x/p', '--max-price', '99']), { _: ['add', 'https://x/p'], flags: { 'max-price': '99' } });
  assert.deepEqual(parseArgs(['watch', '--once', '--log', 'warn']), { _: ['watch'], flags: { once: true, log: 'warn' } });
});

test('${VAR} in a URL is expanded from the environment', async () => {
  process.env.TEST_API_KEY = 'secret123';
  try {
    await withConfig({ targets: [{ id: 'a', url: 'https://api.test/v1?apiKey=${TEST_API_KEY}&x=1' }] }, async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.targets[0].url, 'https://api.test/v1?apiKey=secret123&x=1');
    });
  } finally {
    delete process.env.TEST_API_KEY;
  }
});

test('headers are expanded too, so tokens stay out of the watchlist', async () => {
  process.env.TEST_TOKEN = 'tok_abc';
  try {
    await withConfig(
      { targets: [{ id: 'a', url: 'https://api.test/v1', headers: { authorization: 'Bearer ${TEST_TOKEN}' } }] },
      async (file) => {
        const cfg = await loadConfig(file);
        assert.equal(cfg.targets[0].headers.authorization, 'Bearer tok_abc');
      },
    );
  } finally {
    delete process.env.TEST_TOKEN;
  }
});

test('one missing key disables only its own entry, never the whole watchlist', async () => {
  delete process.env.ABSENT_KEY;
  await withConfig(
    {
      targets: [
        { id: 'needs-key', url: 'https://api.test/v1?apiKey=${ABSENT_KEY}' },
        { id: 'fine', url: 'https://s.test/p' },
      ],
    },
    async (file) => {
      const cfg = await loadConfig(file);
      const [broken, fine] = cfg.targets;
      assert.equal(broken.enabled, false);
      assert.match(broken.disabledReason, /ABSENT_KEY/);
      assert.equal(fine.enabled, true, 'the other retailer still runs');
    },
  );
});

test('expandEnv names the variable and where it was needed', () => {
  delete process.env.NOPE_KEY;
  assert.throws(() => expandEnv('https://x/${NOPE_KEY}', 'bestbuy.url'), (err) => {
    assert.ok(err instanceof MissingEnvError);
    assert.equal(err.variable, 'NOPE_KEY');
    assert.match(err.message, /bestbuy\.url needs NOPE_KEY/);
    return true;
  });
  assert.equal(expandEnv('no placeholders here', 'x'), 'no placeholders here');
  assert.equal(expandEnv(42, 'x'), 42);
});

test('mode must be http or browser', async () => {
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p', mode: 'telepathy' }] }, (f) =>
    assert.rejects(() => loadConfig(f), /"mode" must be "http" or "browser"/),
  );
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p', mode: 'browser' }] }, async (f) => {
    assert.equal((await loadConfig(f)).targets[0].mode, 'browser');
  });
  await withConfig({ targets: [{ id: 'a', url: 'https://s.test/p' }] }, async (f) => {
    assert.equal((await loadConfig(f)).targets[0].mode, 'http', 'plain HTTP stays the default');
  });
});

test('the shipped PS5 Pro watchlist is valid and safe to run as-is', async () => {
  process.env.BESTBUY_API_KEY = 'test-key';
  try {
    const cfg = await loadConfig('config/ps5-pro.example.json');
    assert.ok(cfg.targets.length >= 8, 'covers the major retailers');
    assert.ok(cfg.targets.every((t) => t.url.startsWith('https://')));
    assert.ok(cfg.targets.every((t) => t.mode === 'http' || t.mode === 'browser'));

    // Every retailer that renders stock in JavaScript must say so.
    for (const id of ['target', 'walmart', 'amazon']) {
      assert.equal(cfg.targets.find((t) => t.id === id).mode, 'browser', `${id} needs browser mode`);
    }

    // Browser targets are expensive, so they must not poll at HTTP cadence.
    for (const t of cfg.targets.filter((x) => x.mode === 'browser')) {
      assert.ok(t.hotIntervalMs >= 20_000, `${t.id} polls too hard for a rendered page`);
    }

    // Only the official API is on by default; scraping targets are opt-in.
    const enabled = cfg.targets.filter((t) => t.enabled).map((t) => t.id);
    assert.deepEqual(enabled, ['bestbuy-api']);

    const bestbuy = cfg.targets.find((t) => t.id === 'bestbuy-api');
    assert.ok(bestbuy.url.includes('apiKey=test-key'), 'the key is injected from the environment');
    assert.equal(bestbuy.maxPrice, 800);
  } finally {
    delete process.env.BESTBUY_API_KEY;
  }
});

test('the PS5 Pro watchlist loads without any API key at all', async () => {
  delete process.env.BESTBUY_API_KEY;
  const cfg = await loadConfig('config/ps5-pro.example.json');
  assert.equal(cfg.targets.find((t) => t.id === 'bestbuy-api').enabled, false);
  assert.ok(cfg.targets.length >= 8, 'the other retailers survive');
});
