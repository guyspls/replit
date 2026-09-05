#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig, DEFAULTS, slug } from './config.js';
import { Fetcher, DEFAULT_USER_AGENT } from './fetcher.js';
import { Store } from './state.js';
import { Notifier } from './notify/index.js';
import { Watcher, isHot, computeDelayMs } from './scheduler.js';
import { detectState, detectPrice, DEFAULT_SIGNALS } from './detect.js';
import { runDiscovery } from './discovery.js';
import { logger, setLevel, colors } from './logger.js';

const log = logger('cli');

const USAGE = `
scalper-bot — watch a product page and get told the moment it is buyable.

Usage
  scalper watch                     Run the watcher (this is the main command)
  scalper check <id|url>            Check one target once and explain the verdict
  scalper discover [id]             Run discovery sources once and show what is new
  scalper status                    Show what the watcher knows about each target
  scalper test-notify               Send a test alert through every configured channel
  scalper add <url> [options]       Append a target to the watchlist

Options
  --config <path>     Watchlist file (default config/watchlist.json)
  --log <level>       debug | info | warn | error   (default info)
  --once              For "watch": run a single pass, then exit
  --name <name>       For "add": display name
  --max-price <n>     For "add": do not alert above this price
  --interval <sec>    For "add": seconds between checks
  --drop-at <iso>     For "add": known drop time, e.g. 2026-09-12T14:00:00Z
  --user-agent <ua>   Override the request user agent
  --browser           For "check" on a URL: render with headless Chromium
  --wait-for <sel>    For "check --browser": wait for this selector first

Environment (secrets live here, not in the watchlist)
  NTFY_TOPIC, DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  SLACK_WEBHOOK_URL, RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_WEBHOOK_URL
`;

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) args.flags[key] = inline;
      else if (next === undefined || next.startsWith('--')) args.flags[key] = true;
      else {
        args.flags[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function build(flags) {
  const config = await loadConfig(flags.config);
  const fetcher = new Fetcher({
    userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
    minHostGapMs: config.defaults.minHostGapMs,
    timeoutMs: config.defaults.timeoutMs,
    respectRobots: config.defaults.respectRobots,
  });
  const store = await new Store(config.stateFile).load();
  const notifier = new Notifier(config.notifications);
  return { config, fetcher, store, notifier };
}

const commands = {
  async watch(args) {
    const { config, fetcher, store, notifier } = await build(args.flags);
    const watcher = new Watcher({ config, fetcher, notifier, store });

    const shutdown = async (signal) => {
      log.info(`${signal} received, saving state and exiting`);
      watcher.stop();
      await store.flush(true);
      await fetcher.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    if (notifier.channelNames.length === 0) {
      log.warn('No notification channels configured. Set NTFY_TOPIC to get alerts on your phone in under a minute.');
    }

    const stats = await watcher.run({ maxCycles: args.flags.once ? 1 : Infinity });
    await fetcher.close();
    log.info(`done: ${stats.checks} checks, ${stats.alerts} alerts, ${stats.errors} errors`);
  },

  async check(args) {
    const which = args._[0];
    if (!which) throw new Error('usage: scalper check <id|url>');
    const { config, fetcher, store } = await build(args.flags);

    const target =
      config.targets.find((t) => t.id === which || t.url === which) ??
      (which.startsWith('http')
        ? {
            ...DEFAULTS,
            id: 'ad-hoc',
            name: which,
            url: which,
            respectRobots: config.defaults.respectRobots,
            mode: args.flags.browser ? 'browser' : 'http',
            browser: args.flags['wait-for'] ? { waitFor: String(args.flags['wait-for']) } : undefined,
          }
        : null);
    if (!target) throw new Error(`no target with id "${which}" — pass a URL to check an unlisted page`);

    const record = store.data.targets[target.id];
    process.stdout.write(`\nChecking ${bold(target.name)}\n  ${dim(target.url)}\n\n`);

    const started = Date.now();
    let res;
    try {
      res = await fetcher.get(target.url, {
        headers: target.headers,
        respectRobots: target.respectRobots,
        mode: target.mode,
        browser: target.browser,
      });
    } finally {
      await fetcher.close();
    }

    if (res.blockedByRobots) return void process.stdout.write(`  ${red('blocked by robots.txt')} — ${res.reason}\n\n`);
    if (res.skipped) return void process.stdout.write(`  skipped: ${res.reason}\n\n`);
    if (res.error) return void process.stdout.write(`  ${red('request failed')}: ${res.error}\n\n`);

    const detection = detectState(res.page, target);
    const price = detectPrice(res.page, target);

    const line = (k, v) => process.stdout.write(`  ${k.padEnd(14)} ${v}\n`);
    line('HTTP', `${res.status} in ${Date.now() - started}ms (${(res.body?.length ?? 0).toLocaleString()} bytes)`);
    line('Mode', res.rendered ? 'browser (JavaScript rendered)' : 'http');
    line('State', stateColor(detection.state));
    line('Price', price === null ? dim('not found') : String(price));
    line('Was', record?.state ? String(record.state) : dim('never checked'));
    line('Conditional', res.etag ? `etag ${res.etag.slice(0, 24)}` : res.lastModified ? 'last-modified' : dim('not supported by site'));
    line('Custom rules', target.signals ? 'yes' : dim('no — using built-in defaults'));

    if (detection.reasons.length) {
      process.stdout.write(`\n  Why:\n`);
      for (const r of detection.reasons) process.stdout.write(`    - ${r}\n`);
    } else {
      process.stdout.write(
        `\n  ${dim('No signal matched. The page is probably JavaScript-rendered, or uses wording the defaults do not know.')}\n` +
          `  ${dim('Add a "signals" block to this target — see README "Teaching it a stubborn site".')}\n`,
      );
    }

    if (detection.state !== 'unknown' && detection.state !== 'absent') {
      const { hot, why } = isHot(target, { state: detection.state });
      const seconds = Math.round(computeDelayMs(target, { state: detection.state }) / 1000);
      process.stdout.write('\n');
      line('Next check', `${seconds}s${hot ? ` ${green(`(hot: ${why})`)}` : ''}`);
    }
    process.stdout.write('\n');
  },

  async discover(args) {
    const { config, fetcher, store } = await build(args.flags);
    const only = args._[0];
    const sources = config.discovery.filter((s) => !only || s.id === only);
    if (!sources.length) throw new Error(only ? `no discovery source "${only}"` : 'no discovery sources configured');

    for (const source of sources) {
      const result = await runDiscovery(source, { fetcher, store });
      const found = result.items?.length ?? 0;
      process.stdout.write(
        `\n${bold(source.id)} (${source.kind})\n` +
          `  scanned ${result.scanned ?? 0}, matched ${result.matched ?? 0}, new ${found}` +
          `${result.error ? ` — ${red(result.error)}` : ''}\n`,
      );
      for (const item of result.items ?? []) {
        process.stdout.write(`  ${green('NEW')} ${item.title || ''}\n      ${dim(item.url)}\n`);
      }
    }
    await store.flush();
    await fetcher.close();
    process.stdout.write('\n');
  },

  async status(args) {
    const { config, store } = await build(args.flags);
    process.stdout.write(`\nWatchlist: ${dim(config.path)}\nState:     ${dim(config.stateFile)}\n\n`);
    const rows = config.targets.map((t) => {
      const r = store.data.targets[t.id] ?? {};
      return {
        id: t.id,
        state: r.state ?? '-',
        price: r.price ?? '-',
        checks: r.checks ?? 0,
        last: r.lastCheckedAt ? `${Math.round((Date.now() - r.lastCheckedAt) / 1000)}s ago` : 'never',
        enabled: t.enabled ? '' : ' (disabled)',
      };
    });
    const width = Math.max(8, ...rows.map((r) => r.id.length));
    for (const r of rows) {
      process.stdout.write(
        `  ${r.id.padEnd(width)}  ${stateColor(r.state).padEnd(20)} ${String(r.price).padStart(9)}  ` +
          `${String(r.checks).padStart(5)} checks  ${dim(r.last)}${dim(r.enabled)}\n`,
      );
    }
    if (!rows.length) process.stdout.write('  (no targets)\n');
    process.stdout.write('\n');
  },

  async 'test-notify'(args) {
    const { notifier } = await build(args.flags);
    if (!notifier.channelNames.length) throw new Error('no channels configured — see the Environment section of --help');
    process.stdout.write(`Sending a test alert via: ${notifier.channelNames.join(', ')}\n`);
    const result = await notifier.send({
      title: 'scalper-bot test alert',
      body: 'If you can read this, alerts work.\nThe real one will look like this but say IN STOCK.',
      url: 'https://example.com',
      urgency: 'high',
      tags: ['white_check_mark'],
    });
    if (result.failed.length) {
      process.stdout.write(`${red('Failed:')} ${result.failed.join('; ')}\n`);
      process.exitCode = 1;
    }
  },

  async add(args) {
    const url = args._[0];
    if (!url?.startsWith('http')) throw new Error('usage: scalper add <url> [--name ..] [--max-price ..]');
    const path = args.flags.config ?? process.env.WATCHLIST ?? 'config/watchlist.json';

    let doc;
    try {
      doc = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      doc = { notifications: {}, defaults: {}, targets: [], discovery: [] };
    }
    doc.targets = doc.targets ?? [];

    const name = args.flags.name ?? new URL(url).hostname.replace(/^www\./, '');
    const target = { id: slug(`${name}-${doc.targets.length + 1}`), name, url };
    if (args.flags['max-price']) target.maxPrice = Number(args.flags['max-price']);
    if (args.flags.interval) target.intervalMs = Number(args.flags.interval) * 1000;
    if (args.flags['drop-at']) target.dropAt = String(args.flags['drop-at']);
    if (doc.targets.some((t) => t.url === url)) throw new Error(`${url} is already in the watchlist`);

    doc.targets.push(target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    process.stdout.write(`Added ${bold(target.id)} to ${path}\nTest it with:  npm run check -- ${target.id}\n`);
  },
};

const bold = (s) => `${colors.bold}${s}${colors.reset}`;
const dim = (s) => `${colors.dim}${s}${colors.reset}`;
const red = (s) => `${colors.error}${s}${colors.reset}`;
const green = (s) => `${colors.green}${s}${colors.reset}`;

function stateColor(state) {
  if (state === 'in_stock' || state === 'low_stock') return `${colors.green}${colors.bold}${state}${colors.reset}`;
  if (state === 'preorder' || state === 'coming_soon') return `${colors.warn}${state}${colors.reset}`;
  return dim(state);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const name = args._.shift();

  if (!name || args.flags.help || name === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.flags.log) setLevel(String(args.flags.log));
  if (args.flags['user-agent']) process.env.USER_AGENT = String(args.flags['user-agent']);

  const command = commands[name];
  if (!command) {
    process.stderr.write(`Unknown command "${name}".\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  try {
    await command(args);
  } catch (err) {
    log.error(err.message);
    if (process.env.LOG_LEVEL === 'debug') log.error(err);
    process.exitCode = 1;
  }
}

// Only auto-run as a program, so tests can import this module freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { DEFAULT_USER_AGENT, DEFAULT_SIGNALS };
