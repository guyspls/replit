import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { RobotsCache } from './robots.js';
import { createPage } from './extract.js';
import { BrowserSession } from './browser.js';

const log = logger('fetch');

export const DEFAULT_USER_AGENT =
  'scalper-bot/1.0 (personal stock watcher; +https://github.com/guyspls/replit)';

/** Per-host serialization + floor delay. Being fast at one host still means
 *  being polite to it: requests to the same origin never overlap. */
class HostLimiter {
  constructor(minGapMs) {
    this.minGapMs = minGapMs;
    this.hosts = new Map();
  }

  setGap(host, ms) {
    const entry = this.entry(host);
    entry.gap = Math.max(entry.gap, ms);
  }

  entry(host) {
    if (!this.hosts.has(host)) this.hosts.set(host, { chain: Promise.resolve(), last: 0, gap: this.minGapMs });
    return this.hosts.get(host);
  }

  run(host, fn) {
    const entry = this.entry(host);
    const result = entry.chain.then(async () => {
      const wait = entry.last + entry.gap - Date.now();
      if (wait > 0) await sleep(wait);
      entry.last = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of this call's outcome.
    entry.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Fetcher {
  constructor({
    userAgent = DEFAULT_USER_AGENT,
    minHostGapMs = 1000,
    timeoutMs = 15_000,
    respectRobots = true,
    fetchImpl = fetch,
    maxRetries = 2,
  } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.respectRobots = respectRobots;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.limiter = new HostLimiter(minHostGapMs);
    this.robots = new RobotsCache({ fetchImpl, userAgent });
    this.backoffUntil = new Map();
    this.browserSession = null; // started lazily, only if a target asks for it
  }

  /** Shared across every browser-mode target, so one Chromium serves them all. */
  browser() {
    if (!this.browserSession) {
      this.browserSession = new BrowserSession({ userAgent: this.userAgent, timeoutMs: this.timeoutMs * 2 });
    }
    return this.browserSession;
  }

  async close() {
    if (this.browserSession) await this.browserSession.close();
    this.browserSession = null;
  }

  /**
   * Fetches one URL and returns a Page plus caching metadata.
   * `notModified` is true when the server answered 304, in which case the
   * caller can skip parsing entirely and reuse the previous state.
   */
  async get(url, { etag, lastModified, headers = {}, respectRobots, method = 'GET', mode = 'http', browser } = {}) {
    const host = new URL(url).host;

    const blockedUntil = this.backoffUntil.get(host) ?? 0;
    if (Date.now() < blockedUntil) {
      const waitMs = blockedUntil - Date.now();
      return { skipped: true, reason: `backing off ${host} for ${Math.ceil(waitMs / 1000)}s`, waitMs };
    }

    const checkRobots = respectRobots ?? this.respectRobots;
    if (checkRobots) {
      const verdict = await this.robots.isAllowed(url);
      if (!verdict.allowed) {
        return { skipped: true, blockedByRobots: true, reason: `robots.txt says no (${verdict.reason})` };
      }
      if (verdict.crawlDelay) this.limiter.setGap(host, verdict.crawlDelay * 1000);
    }

    // Browser mode reuses the same politeness machinery: robots above, and the
    // per-host queue below, so rendering does not become a way to poll harder.
    if (mode === 'browser') {
      return this.limiter.run(host, () => this.renderAttempt(url, { headers, host, ...browser }));
    }

    return this.limiter.run(host, () =>
      this.attempt(url, { etag, lastModified, headers, method, host }),
    );
  }

  async renderAttempt(url, opts) {
    const startedAt = Date.now();
    let rendered;
    try {
      rendered = await this.browser().get(url, opts);
    } catch (err) {
      return { error: `browser: ${err.message}`, elapsedMs: Date.now() - startedAt };
    }

    const { status, headers, body } = rendered;
    if (status === 429 || status === 503) {
      const waitMs = retryAfterMs(headers['retry-after']) ?? backoffMs(2);
      this.backoffUntil.set(opts.host, Date.now() + waitMs);
      return { status, headers, throttled: true, waitMs, elapsedMs: Date.now() - startedAt };
    }

    return {
      status,
      headers,
      body,
      url: rendered.url,
      etag: null, // conditional requests do not apply to a rendered page
      lastModified: null,
      hash: hashBody(body),
      elapsedMs: Date.now() - startedAt,
      rendered: true,
      page: createPage({ url: rendered.url, status, headers, body }),
    };
  }

  async attempt(url, opts, retry = 0) {
    const requestHeaders = {
      'user-agent': this.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      ...opts.headers,
    };
    // Conditional requests: a 304 is an order of magnitude cheaper than a body,
    // which is what lets hot mode poll every couple of seconds without abuse.
    if (opts.etag) requestHeaders['if-none-match'] = opts.etag;
    if (opts.lastModified) requestHeaders['if-modified-since'] = opts.lastModified;

    const startedAt = Date.now();
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (retry < this.maxRetries) {
        const wait = backoffMs(retry);
        log.debug(`${url} failed (${err.message}), retry ${retry + 1} in ${wait}ms`);
        await sleep(wait);
        return this.attempt(url, opts, retry + 1);
      }
      return { error: err.message, elapsedMs: Date.now() - startedAt };
    }

    const headers = headersToObject(res.headers);

    if (res.status === 429 || res.status === 503) {
      const waitMs = retryAfterMs(headers['retry-after']) ?? backoffMs(retry + 2);
      this.backoffUntil.set(opts.host, Date.now() + waitMs);
      log.warn(`${opts.host} returned ${res.status}; pausing that host for ${Math.round(waitMs / 1000)}s`);
      return { status: res.status, headers, throttled: true, waitMs, elapsedMs: Date.now() - startedAt };
    }

    if (res.status === 304) {
      return {
        status: 304,
        headers,
        notModified: true,
        etag: headers.etag ?? opts.etag,
        lastModified: headers['last-modified'] ?? opts.lastModified,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (res.status >= 500 && retry < this.maxRetries) {
      const wait = backoffMs(retry);
      await sleep(wait);
      return this.attempt(url, opts, retry + 1);
    }

    const body = res.status === 204 ? '' : await res.text();
    this.backoffUntil.delete(opts.host);

    return {
      status: res.status,
      headers,
      body,
      url: res.url || url,
      etag: headers.etag ?? null,
      lastModified: headers['last-modified'] ?? null,
      hash: hashBody(body),
      elapsedMs: Date.now() - startedAt,
      page: createPage({ url: res.url || url, status: res.status, headers, body }),
    };
  }
}

export function hashBody(body) {
  return createHash('sha1').update(body ?? '').digest('hex').slice(0, 16);
}

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

export function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 15 * 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 15 * 60_000));
  return null;
}

export function backoffMs(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 60_000);
  return Math.round(base * (0.5 + Math.random()));
}
