import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A controllable storefront. Tests flip `server.state` and the pages it serves
 * change, which is how the stock ladder gets exercised for real over HTTP.
 */
export async function startStore({ etagSupport = true, robots = null } = {}) {
  const ctx = {
    state: 'absent',
    hits: 0,
    conditionalHits: 0,
    lastHeaders: null,
    price: '499.00',
    status: null,
  };

  const bodies = {
    absent: null,
    coming_soon: '<html><body><h1>Widget</h1><button>Notify me when available</button></body></html>',
    out_of_stock: '<html><body><h1>Widget</h1><span>Sold out</span></body></html>',
    preorder: '<html><body><h1>Widget</h1><button>Pre-order now</button></body></html>',
    in_stock: () =>
      `<html><body><h1>Widget</h1><button>Add to cart</button>` +
      `<script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/InStock","price":"${ctx.price}"}}</script>` +
      `</body></html>`,
    low_stock: '<html><body><button>Add to cart</button><span>Only 2 left</span></body></html>',
  };

  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      if (robots === null) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
    }

    ctx.hits += 1;
    ctx.lastHeaders = req.headers;

    if (ctx.status) return void res.writeHead(ctx.status, { 'retry-after': '1' }).end('nope');

    const raw = bodies[ctx.state];
    const body = typeof raw === 'function' ? raw() : raw;
    if (body === null) return void res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not Found</h1>');

    const etag = `"${ctx.state}-${ctx.price}"`;
    if (etagSupport && req.headers['if-none-match'] === etag) {
      ctx.conditionalHits += 1;
      return void res.writeHead(304, { etag }).end();
    }
    const headers = { 'content-type': 'text/html' };
    if (etagSupport) headers.etag = etag;
    res.writeHead(200, headers).end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    ctx,
    url: (path = '/p') => `http://127.0.0.1:${port}${path}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'scalper-test-'));
  return { dir, file: join(dir, 'state.json'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Notifier stand-in that records instead of sending. */
export function recorder() {
  const sent = [];
  return {
    sent,
    channelNames: ['recorder'],
    async send(alert) {
      sent.push(alert);
      return { delivered: ['recorder'], failed: [] };
    },
  };
}
