import { logger } from './logger.js';

const log = logger('robots');

/**
 * Minimal robots.txt evaluator: longest-match Allow/Disallow over the
 * most specific matching user-agent group, per the de-facto standard.
 * Fetch failures fail open — an unreachable robots.txt is not a prohibition.
 */
export class RobotsCache {
  constructor({ fetchImpl = fetch, userAgent = '*', ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent.toLowerCase();
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async isAllowed(url) {
    const target = new URL(url);
    const rules = await this.rulesFor(target.origin);
    if (!rules) return { allowed: true, reason: 'no robots.txt' };
    return matchPath(rules, target.pathname + target.search);
  }

  async rulesFor(origin) {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.rules;

    let rules = null;
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { 'user-agent': this.userAgent, accept: 'text/plain' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        rules = parseRobots(await res.text(), this.userAgent);
      } else {
        log.debug(`${origin}/robots.txt -> HTTP ${res.status}, treating as unrestricted`);
      }
    } catch (err) {
      log.debug(`${origin}/robots.txt unreachable (${err.message}), treating as unrestricted`);
    }
    this.cache.set(origin, { at: Date.now(), rules });
    return rules;
  }
}

export function parseRobots(text, userAgent = '*') {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (!current) continue;
    lastWasAgent = false;

    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    else if (field === 'allow') current.rules.push({ allow: true, path: value });
    else if (field === 'crawl-delay') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  // Exact user-agent match wins over the wildcard group.
  const exact = groups.filter((g) => g.agents.some((a) => a !== '*' && userAgent.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = exact.length ? exact : wildcard;
  if (!chosen.length) return null;

  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.map((g) => g.crawlDelay).find((d) => d !== null) ?? null,
  };
}

export function matchPath(rules, path) {
  let best = null;
  for (const rule of rules.rules) {
    if (rule.path === '') {
      // "Disallow:" with an empty value explicitly allows everything.
      if (!rule.allow && !best) best = { allow: true, length: 0, pattern: '<empty disallow>' };
      continue;
    }
    if (!globMatch(rule.path, path)) continue;
    const length = rule.path.length;
    // Longest match wins; Allow beats Disallow at equal length.
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length, pattern: rule.path };
    }
  }
  if (!best) return { allowed: true, reason: 'no matching rule' };
  return {
    allowed: best.allow,
    reason: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}`,
    crawlDelay: rules.crawlDelay,
  };
}

function globMatch(pattern, path) {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`).test(path);
}
