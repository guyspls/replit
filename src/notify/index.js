import { logger } from '../logger.js';
import ntfy from './ntfy.js';
import discord from './discord.js';
import telegram from './telegram.js';
import slack from './slack.js';
import email from './email.js';
import webhook from './webhook.js';
import desktop from './desktop.js';

const log = logger('notify');

export const CHANNELS = [ntfy, discord, telegram, slack, email, webhook, desktop];

export class Notifier {
  constructor(config = {}, { fetchImpl = fetch, channels = CHANNELS, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.channels = channels.filter((c) => {
      if (config[c.name] === false) return false;
      if (c.configured(config)) return true;
      // Half-filled config is a likely typo, and silence here would look like
      // a working setup right up until the drop it fails to tell you about.
      if (config[c.name]) log.warn(`${c.name} is configured but missing required fields — skipping it`);
      return false;
    });
  }

  get channelNames() {
    return this.channels.map((c) => c.name);
  }

  /**
   * Fans out to every configured channel in parallel. One dead channel must
   * never delay or suppress the others — when a drop happens, the phone push
   * should not be waiting on an SMTP timeout.
   */
  async send(alert) {
    const full = { at: this.now(), urgency: 'default', tags: [], ...alert };
    if (this.channels.length === 0) {
      log.warn('no notification channels configured — alert only printed to console');
      log.info(`${full.title} :: ${full.url ?? ''}`);
      return { delivered: [], failed: [] };
    }

    const results = await Promise.allSettled(
      this.channels.map(async (channel) => {
        try {
          await channel.send(this.config, full, this.fetchImpl);
          return channel.name;
        } catch (err) {
          throw new Error(`${channel.name}: ${err.message}`);
        }
      }),
    );

    const delivered = [];
    const failed = [];
    for (const r of results) {
      if (r.status === 'fulfilled') delivered.push(r.value);
      else {
        failed.push(r.reason.message);
        log.error(`notification failed via ${r.reason.message}`);
      }
    }
    if (delivered.length) log.info(`alert sent via ${delivered.join(', ')}`);
    return { delivered, failed };
  }
}

/**
 * Damps runaway alerting without ever silencing a real event.
 *
 * A plain cooldown cannot tell "this page is flapping between in_stock and
 * unknown every 2 seconds" apart from "it sold out and genuinely restocked ten
 * minutes later" — and swallowing the second case defeats the whole bot. A
 * sliding-window rate limit separates them: a handful of genuine transitions
 * always get through, while an oscillating page hits the ceiling and goes
 * quiet with a log line explaining why.
 */
export class AlertGate {
  constructor({ maxPerWindow = 3, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now;
  }

  recentCount(record, key, windowMs = this.windowMs) {
    const cutoff = this.now() - windowMs;
    return (record.alertLog?.[key] ?? []).filter((t) => t >= cutoff).length;
  }

  shouldSend(record, key, { maxPerWindow = this.maxPerWindow, windowMs = this.windowMs } = {}) {
    return this.recentCount(record, key, windowMs) < maxPerWindow;
  }

  mark(record, key) {
    record.alertLog = record.alertLog ?? {};
    const entries = [...(record.alertLog[key] ?? []), this.now()].slice(-10);
    record.alertLog[key] = entries;
    // Bound the key set too, so a long-lived watch cannot grow state forever.
    const keys = Object.entries(record.alertLog)
      .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
      .slice(0, 20);
    record.alertLog = Object.fromEntries(keys);
  }
}

/** Builds the human-facing alert for a stock transition. */
export function buildAlert({ target, state, previous, price, urgency, kind, reasons = [] }) {
  const label = target.name ?? target.id;
  const headline = {
    in_stock: `IN STOCK: ${label}`,
    low_stock: `IN STOCK (low): ${label}`,
    preorder: `PREORDER OPEN: ${label}`,
    coming_soon: `HEADS UP: ${label} listing is live`,
  }[state] ?? `${label}: ${previous ?? 'unknown'} -> ${state}`;

  const lines = [];
  if (kind === 'early-warning') {
    lines.push('Not buyable yet — this is the early warning.');
  }
  lines.push(`State: ${previous ?? 'first check'} -> ${state}`);
  if (price !== null && price !== undefined) lines.push(`Price: ${formatPrice(price, target.currency)}`);
  if (target.maxPrice) lines.push(`Your max: ${formatPrice(target.maxPrice, target.currency)}`);
  if (reasons.length) lines.push(`Signal: ${truncate(reasons[0], 90)}`);

  return {
    title: headline,
    body: lines.join('\n'),
    url: target.buyUrl ?? target.url,
    urgency,
    tags: urgency === 'max' ? ['rotating_light', 'shopping_cart'] : ['eyes'],
    targetId: target.id,
    state,
    previous,
    price: price ?? null,
  };
}

export const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function formatPrice(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}
