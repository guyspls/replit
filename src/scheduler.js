import { logger } from './logger.js';
import { detectState, detectPrice, classifyTransition, isBuyable } from './detect.js';
import { buildAlert, AlertGate } from './notify/index.js';
import { runDiscovery, targetFromDiscovery } from './discovery.js';
import { sleep } from './fetcher.js';

const log = logger('watch');

/**
 * "Hot" means the target is worth polling hard right now. Sitting at a flat
 * interval either wastes requests for months or misses the drop by 59 seconds;
 * hot mode spends the request budget in the window where it actually matters.
 */
export function isHot(target, record, now = Date.now()) {
  if (target.alwaysHot) return { hot: true, why: 'alwaysHot' };

  if (target.dropAt) {
    const from = target.dropAt - target.hotBeforeMs;
    const to = target.dropAt + target.hotAfterMs;
    if (now >= from && now <= to) return { hot: true, why: 'drop window' };
  }

  // A live "coming soon" or preorder page is the last state before buyable —
  // this is exactly when seconds start to count.
  if (record?.state === 'coming_soon' || record?.state === 'preorder') {
    return { hot: true, why: `state=${record.state}` };
  }

  return { hot: false };
}

export function applyJitter(ms, ratio, random = Math.random) {
  if (!ratio) return ms;
  const spread = ms * ratio;
  return Math.max(500, Math.round(ms - spread / 2 + random() * spread));
}

export function computeDelayMs(target, record, now = Date.now(), random = Math.random) {
  const { hot } = isHot(target, record, now);
  let base = hot ? target.hotIntervalMs : target.intervalMs;

  // Consecutive failures back off so a dead URL or a hostile host does not get
  // hammered at hot cadence forever.
  const failures = record?.failures ?? 0;
  if (failures > 0) base = Math.min(base * 2 ** Math.min(failures, 5), 30 * 60_000);

  return applyJitter(base, target.jitterRatio, random);
}

/** Bounded parallelism, so N targets do not open N sockets at once. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        log.error(`unhandled error: ${err.stack ?? err.message}`);
      }
    }
  });
  await Promise.all(runners);
}

export class Watcher {
  constructor({ config, fetcher, notifier, store, now = () => Date.now() }) {
    this.config = config;
    this.fetcher = fetcher;
    this.notifier = notifier;
    this.store = store;
    this.now = now;
    this.gate = new AlertGate({
      maxPerWindow: config.defaults.alertBurst,
      windowMs: config.defaults.burstWindowMs,
      now,
    });
    this.targets = config.targets.filter((t) => t.enabled);
    this.sources = config.discovery.filter((d) => d.enabled);
    this.due = new Map();
    this.stopping = false;
    this.stats = { checks: 0, alerts: 0, errors: 0, discovered: 0 };
  }

  scheduleNext(id, delayMs) {
    this.due.set(id, this.now() + delayMs);
  }

  /** Checks one product target end to end. Returns a short outcome record. */
  async checkTarget(target) {
    const record = this.store.target(target.id);
    const res = await this.fetcher.get(target.url, {
      etag: record.etag,
      lastModified: record.lastModified,
      headers: target.headers,
      respectRobots: target.respectRobots,
    });

    this.stats.checks += 1;
    const patch = { lastCheckedAt: this.now(), checks: (record.checks ?? 0) + 1 };

    if (res.blockedByRobots) {
      log.warn(`${target.id}: ${res.reason} — disable it or set "respectRobots": false for this target if you have permission`);
      this.store.update(target.id, { ...patch, failures: (record.failures ?? 0) + 1, lastError: res.reason });
      return { outcome: 'blocked' };
    }
    if (res.skipped) {
      log.debug(`${target.id}: ${res.reason}`);
      this.store.update(target.id, patch);
      return { outcome: 'skipped' };
    }
    if (res.throttled) {
      this.store.update(target.id, { ...patch, failures: (record.failures ?? 0) + 1, lastError: `HTTP ${res.status}` });
      return { outcome: 'throttled' };
    }
    if (res.error) {
      this.stats.errors += 1;
      log.warn(`${target.id}: ${res.error}`);
      this.store.update(target.id, { ...patch, failures: (record.failures ?? 0) + 1, lastError: res.error });
      return { outcome: 'error', error: res.error };
    }

    if (res.notModified) {
      log.debug(`${target.id}: unchanged (304) in ${res.elapsedMs}ms`);
      this.store.update(target.id, { ...patch, failures: 0, etag: res.etag, lastModified: res.lastModified });
      return { outcome: 'unchanged', state: record.state };
    }

    const detection = detectState(res.page, target);
    const price = detectPrice(res.page, target);
    const previous = record.state;
    const changed = record.bodyHash !== null && record.bodyHash !== res.hash;

    this.store.update(target.id, {
      ...patch,
      failures: 0,
      lastError: null,
      etag: res.etag,
      lastModified: res.lastModified,
      bodyHash: res.hash,
      state: detection.state,
      price,
      lastChangedAt: detection.state !== previous ? this.now() : record.lastChangedAt,
    });

    const transition = classifyTransition(previous, detection.state);
    log.debug(
      `${target.id}: ${previous ?? '-'} -> ${detection.state} (${res.elapsedMs}ms)${changed ? ' [body changed]' : ''}`,
    );

    if (transition.alert) {
      const suppressed = this.priceGuard(target, detection.state, price);
      if (suppressed) {
        log.info(`${target.id}: ${detection.state} but ${suppressed} — not alerting`);
        return { outcome: 'suppressed', state: detection.state, reason: suppressed };
      }
      await this.fire(target, {
        state: detection.state,
        previous,
        price,
        urgency: transition.urgency,
        kind: transition.kind,
        reasons: detection.reasons,
      });
      return { outcome: 'alert', state: detection.state, urgency: transition.urgency };
    }

    // Opt-in: tell me the moment *anything* on this page moves. The earliest
    // possible signal, at the cost of occasional noise from banners and ads.
    if (changed && target.alertOnChange) {
      // Body hashes move on every ad rotation, so these keep the long cooldown.
      await this.send(
        target,
        {
          title: `Page changed: ${target.name}`,
          body: `Content changed while state stayed ${detection.state}.\nOften the first sign a drop is being staged.`,
          url: target.buyUrl ?? target.url,
          urgency: 'low',
          tags: ['eyes'],
          targetId: target.id,
          state: detection.state,
        },
        'change',
        { maxPerWindow: 1, windowMs: target.cooldownMs },
      );
      return { outcome: 'changed', state: detection.state };
    }

    return { outcome: 'ok', state: detection.state };
  }

  /** Guards against alerting on a listing that is buyable but not at your price. */
  priceGuard(target, state, price) {
    if (!target.maxPrice || price === null || !isBuyable(state)) return null;
    if (price <= target.maxPrice) return null;
    if (target.alertOverPrice) return null;
    return `price ${price} is over your max of ${target.maxPrice}`;
  }

  async fire(target, details) {
    const alert = buildAlert({ target, ...details });
    // Forward transitions are news by construction, so they only face the burst
    // ceiling. A sell-out followed by a real restock must always get through.
    await this.send(target, alert, `${details.state}`, {
      maxPerWindow: target.alertBurst,
      windowMs: target.burstWindowMs,
    });
  }

  async send(target, alert, key, limit) {
    const record = this.store.target(target.id);
    if (!this.gate.shouldSend(record, key, limit)) {
      log.warn(
        `${target.id}: suppressing "${key}" — already alerted ${this.gate.recentCount(record, key, limit?.windowMs)} ` +
          `times recently, which usually means the page is flapping rather than really changing`,
      );
      return;
    }
    this.gate.mark(record, key);
    this.store.dirty = true;
    this.stats.alerts += 1;
    await this.notifier.send(alert);
    await this.store.flush();
  }

  async checkDiscovery(source) {
    const result = await runDiscovery(source, { fetcher: this.fetcher, store: this.store });
    if (result.error) {
      log.warn(`${source.id}: ${result.error}`);
      return result;
    }
    if (result.skipped) {
      log.debug(`${source.id}: ${result.reason}`);
      return result;
    }

    for (const item of result.items ?? []) {
      this.stats.discovered += 1;
      log.info(`${source.id}: new listing — ${item.title || item.url}`);
      await this.notifier.send({
        title: `New listing found: ${(item.title || item.url).slice(0, 80)}`,
        body: `Matched "${source.keywords.join(', ')}" via ${source.kind}.\nThis is ahead of the drop — open it and set a watch.`,
        url: item.url,
        urgency: 'high',
        tags: ['mag'],
        targetId: source.id,
      });

      if (source.autoWatch && item.url) {
        const target = normalizeDiscovered(targetFromDiscovery(item, source), this.config.defaults);
        if (!this.targets.some((t) => t.url === target.url)) {
          this.targets.push(target);
          this.scheduleNext(target.id, 0);
          log.info(`${source.id}: now watching ${target.id} automatically`);
        }
      }
    }
    await this.store.flush();
    return result;
  }

  /** Main loop. Runs until `stop()` or, in tests, until `maxCycles`. */
  async run({ maxCycles = Infinity, tickMs = 250 } = {}) {
    const now = this.now();
    for (const t of this.targets) this.scheduleNext(t.id, 0); // sweep everything once on boot
    for (const s of this.sources) this.due.set(s.id, now);

    log.info(
      `watching ${this.targets.length} target(s) and ${this.sources.length} discovery source(s); ` +
        `notifying via ${this.notifier.channelNames.join(', ') || 'console only'}`,
    );

    let cycles = 0;
    while (!this.stopping && cycles < maxCycles) {
      cycles += 1;
      const at = this.now();

      const dueTargets = this.targets.filter((t) => (this.due.get(t.id) ?? 0) <= at);
      const dueSources = this.sources.filter((s) => (this.due.get(s.id) ?? 0) <= at);

      if (dueTargets.length) {
        await pool(dueTargets, this.config.defaults.maxConcurrency, async (target) => {
          await this.checkTarget(target);
          const record = this.store.target(target.id);
          this.scheduleNext(target.id, computeDelayMs(target, record, this.now()));
        });
      }

      if (dueSources.length) {
        await pool(dueSources, 2, async (source) => {
          await this.checkDiscovery(source);
          this.scheduleNext(source.id, applyJitter(source.intervalMs, source.jitterRatio));
        });
      }

      await this.store.flush();
      if (this.stopping || cycles >= maxCycles) break;

      const nextAt = Math.min(...[...this.due.values()], at + 60_000);
      const waitMs = Math.max(0, Math.min(nextAt - this.now(), 60_000));
      await sleep(Math.max(waitMs, tickMs));
    }

    await this.store.flush(true);
    return this.stats;
  }

  stop() {
    this.stopping = true;
  }
}

function normalizeDiscovered(target, defaults) {
  return {
    intervalMs: defaults.intervalMs,
    hotIntervalMs: defaults.hotIntervalMs,
    hotBeforeMs: defaults.hotBeforeMs,
    hotAfterMs: defaults.hotAfterMs,
    jitterRatio: defaults.jitterRatio,
    cooldownMs: defaults.cooldownMs,
    respectRobots: defaults.respectRobots,
    currency: 'USD',
    maxPrice: null,
    dropAt: null,
    enabled: true,
    ...target,
  };
}
