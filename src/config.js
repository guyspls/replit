import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from './logger.js';

const log = logger('config');

export const DEFAULTS = {
  intervalMs: 60_000,
  hotIntervalMs: 3_000,
  jitterRatio: 0.15,
  cooldownMs: 15 * 60_000,
  alertBurst: 3,
  burstWindowMs: 10 * 60_000,
  minHostGapMs: 1_000,
  timeoutMs: 15_000,
  respectRobots: true,
  hotBeforeMs: 15 * 60_000,
  hotAfterMs: 30 * 60_000,
  maxConcurrency: 6,
};

/** Secrets belong in the environment, not in a file you might commit. */
function notificationsFromEnv(base = {}) {
  const cfg = structuredClone(base);
  const set = (path, value) => {
    if (!value) return;
    const [group, key] = path;
    cfg[group] = cfg[group] ?? {};
    if (cfg[group][key] === undefined) cfg[group][key] = value;
  };

  set(['ntfy', 'topic'], process.env.NTFY_TOPIC);
  set(['ntfy', 'server'], process.env.NTFY_SERVER);
  set(['ntfy', 'token'], process.env.NTFY_TOKEN);
  set(['discord', 'webhookUrl'], process.env.DISCORD_WEBHOOK_URL);
  set(['telegram', 'botToken'], process.env.TELEGRAM_BOT_TOKEN);
  set(['telegram', 'chatId'], process.env.TELEGRAM_CHAT_ID);
  set(['slack', 'webhookUrl'], process.env.SLACK_WEBHOOK_URL);
  set(['email', 'apiKey'], process.env.RESEND_API_KEY);
  set(['email', 'to'], process.env.ALERT_EMAIL_TO);
  set(['email', 'from'], process.env.ALERT_EMAIL_FROM);
  set(['webhook', 'url'], process.env.ALERT_WEBHOOK_URL);
  if (process.env.DESKTOP_NOTIFICATIONS === 'false') cfg.desktop = false;
  return cfg;
}

export function loadEnvFile(dir = process.cwd()) {
  const file = join(dir, '.env');
  if (!existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch (err) {
    log.warn(`could not read .env: ${err.message}`);
    return false;
  }
}

export async function loadConfig(file) {
  loadEnvFile();

  const path = resolve(file ?? process.env.WATCHLIST ?? join(process.cwd(), 'config', 'watchlist.json'));
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No watchlist at ${path}\n` +
          `Create one with:  cp config/watchlist.example.json config/watchlist.json`,
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const defaults = { ...DEFAULTS, ...(parsed.defaults ?? {}) };

  // A watchlist spanning several retailers should not be unusable because one
  // of them needs an API key you have not set up yet. Disable that entry, say
  // so once, and let the rest run.
  const skipMissingEnv = (normalize) => (entry, i) => {
    try {
      return normalize(entry, i, defaults);
    } catch (err) {
      if (!(err instanceof MissingEnvError)) throw err;
      log.warn(`${err.message} — that entry is disabled for this run`);
      return { ...entry, id: entry.id ?? `entry-${i}`, enabled: false, disabledReason: err.message };
    }
  };

  const targets = (parsed.targets ?? []).map(skipMissingEnv(normalizeTarget));
  const discovery = (parsed.discovery ?? []).map(skipMissingEnv(normalizeDiscovery));

  const ids = new Set();
  for (const t of [...targets, ...discovery]) {
    if (ids.has(t.id)) throw new Error(`duplicate id "${t.id}" — ids must be unique across targets and discovery`);
    ids.add(t.id);
  }

  if (targets.length === 0 && discovery.length === 0) {
    throw new Error(`${path} has no targets and no discovery sources`);
  }

  return {
    path,
    defaults,
    notifications: notificationsFromEnv(parsed.notifications ?? {}),
    targets,
    discovery,
    stateFile: resolve(parsed.stateFile ?? process.env.STATE_FILE ?? join(process.cwd(), 'data', 'state.json')),
  };
}

/**
 * Expands ${VAR} against the environment so API keys and store ids live in
 * .env rather than in a watchlist you might commit or paste into a chat.
 */
export class MissingEnvError extends Error {
  constructor(name, where) {
    super(`${where} needs ${name}, which is not set — add ${name} to your .env`);
    this.name = 'MissingEnvError';
    this.variable = name;
  }
}

export function expandEnv(value, where) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
    const found = process.env[name];
    if (found === undefined || found === '') throw new MissingEnvError(name, where);
    return found;
  });
}

function expandHeaders(headers, where) {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnv(v, `${where}.headers.${k}`)]));
}

function normalizeTarget(target, index, defaults) {
  const where = target.id ?? target.name ?? `targets[${index}]`;
  if (!target.url) throw new Error(`${where}: "url" is required`);
  const url = expandEnv(target.url, `${where}.url`);
  assertHttpUrl(url, `${where}.url`);
  if (target.buyUrl) assertHttpUrl(target.buyUrl, `${where}.buyUrl`);

  const mode = target.mode ?? 'http';
  if (mode !== 'http' && mode !== 'browser') {
    throw new Error(`${where}: "mode" must be "http" or "browser", got "${mode}"`);
  }

  const id = target.id ?? slug(target.name ?? new URL(target.url).pathname);
  const dropAt = target.dropAt ? Date.parse(target.dropAt) : null;
  if (target.dropAt && !Number.isFinite(dropAt)) {
    throw new Error(`${where}: "dropAt" is not a valid date (use ISO 8601, e.g. 2026-09-12T14:00:00Z)`);
  }

  const intervalMs = Math.max(target.intervalMs ?? defaults.intervalMs, 1000);
  const hotIntervalMs = Math.max(target.hotIntervalMs ?? defaults.hotIntervalMs, 1000);

  return {
    ...target,
    id,
    url,
    mode,
    headers: expandHeaders(target.headers, where),
    name: target.name ?? id,
    enabled: target.enabled !== false,
    intervalMs,
    hotIntervalMs,
    hotBeforeMs: target.hotBeforeMs ?? defaults.hotBeforeMs,
    hotAfterMs: target.hotAfterMs ?? defaults.hotAfterMs,
    jitterRatio: target.jitterRatio ?? defaults.jitterRatio,
    cooldownMs: target.cooldownMs ?? defaults.cooldownMs,
    alertBurst: target.alertBurst ?? defaults.alertBurst,
    burstWindowMs: target.burstWindowMs ?? defaults.burstWindowMs,
    respectRobots: target.respectRobots ?? defaults.respectRobots,
    dropAt,
    maxPrice: target.maxPrice ?? null,
    currency: target.currency ?? 'USD',
  };
}

function normalizeDiscovery(source, index, defaults) {
  const where = source.id ?? `discovery[${index}]`;
  const kinds = ['sitemap', 'search', 'feed'];
  if (!kinds.includes(source.kind)) {
    throw new Error(`${where}: "kind" must be one of ${kinds.join(', ')}`);
  }
  if (!source.url) throw new Error(`${where}: "url" is required`);
  const url = expandEnv(source.url, `${where}.url`);
  assertHttpUrl(url.replace('{query}', 'x'), `${where}.url`);
  if (!source.keywords?.length) throw new Error(`${where}: "keywords" must be a non-empty array`);

  return {
    ...source,
    url,
    headers: expandHeaders(source.headers, where),
    id: source.id ?? slug(`${source.kind}-${index}`),
    enabled: source.enabled !== false,
    intervalMs: Math.max(source.intervalMs ?? 10 * 60_000, 30_000),
    jitterRatio: source.jitterRatio ?? defaults.jitterRatio,
    respectRobots: source.respectRobots ?? defaults.respectRobots,
    keywords: source.keywords.map((k) => String(k)),
    matchAll: source.matchAll ?? false,
    autoWatch: source.autoWatch ?? false,
  };
}

function assertHttpUrl(value, where) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${where}: "${value}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${where}: only http(s) URLs are supported, got ${parsed.protocol}`);
  }
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'target';
}
