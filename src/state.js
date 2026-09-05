import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

const log = logger('state');

/**
 * Durable per-target memory. Its job is to make restarts boring: without it the
 * watcher would re-alert for everything it has ever seen the moment it boots.
 */
export class Store {
  constructor(file = join(process.cwd(), 'data', 'state.json')) {
    this.file = file;
    this.data = { version: 1, targets: {}, discovery: {} };
    this.dirty = false;
    this.flushing = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { version: 1, targets: {}, discovery: {}, ...parsed };
      }
      log.debug(`loaded ${Object.keys(this.data.targets).length} target(s) from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`could not read state, starting fresh: ${err.message}`);
    }
    return this;
  }

  target(id) {
    if (!this.data.targets[id]) {
      this.data.targets[id] = {
        state: null,
        price: null,
        lastCheckedAt: null,
        lastChangedAt: null,
        alertLog: {},
        checks: 0,
        failures: 0,
        etag: null,
        lastModified: null,
        bodyHash: null,
      };
    }
    return this.data.targets[id];
  }

  update(id, patch) {
    Object.assign(this.target(id), patch);
    this.dirty = true;
  }

  discovery(sourceId) {
    if (!this.data.discovery[sourceId]) this.data.discovery[sourceId] = { seen: [], lastRunAt: null };
    return this.data.discovery[sourceId];
  }

  markSeen(sourceId, keys) {
    const entry = this.discovery(sourceId);
    const set = new Set(entry.seen);
    const fresh = keys.filter((k) => !set.has(k));
    // Cap the ring so a large sitemap cannot grow state.json without bound.
    entry.seen = [...entry.seen, ...fresh].slice(-5000);
    entry.lastRunAt = Date.now();
    this.dirty = true;
    return fresh;
  }

  /** Atomic write — a crash mid-save must not leave a truncated state file. */
  async flush(force = false) {
    if (!this.dirty && !force) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const payload = JSON.stringify(this.data, null, 2);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.file);
      this.dirty = false;
    })();
    try {
      await this.flushing;
    } catch (err) {
      log.error(`failed to persist state: ${err.message}`);
    } finally {
      this.flushing = null;
    }
  }
}
