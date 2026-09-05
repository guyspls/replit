import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

const log = logger('browser');

/**
 * Renders a page in headless Chromium for sites that decide stock in
 * JavaScript — which is most large retailers. This is a real browser loading a
 * page a shopper could load: no fingerprint spoofing, no CAPTCHA solving, no
 * proxy rotation. If a retailer still refuses, the answer is their own stock
 * notification list or API, not a fight you will lose.
 */
export class BrowserSession {
  constructor({ userAgent, timeoutMs = 30_000, headless = true } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.headless = headless;
    this.browser = null;
    this.context = null;
    this.starting = null;
  }

  async start() {
    if (this.context) return this.context;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        throw new Error(
          'browser mode needs Playwright. Install it with:  npm install playwright && npx playwright install chromium',
        );
      }

      const executablePath = resolveExecutablePath();
      const launchOptions = { headless: this.headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
      if (executablePath) {
        log.debug(`using chromium at ${executablePath}`);
        launchOptions.executablePath = executablePath;
      }

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        userAgent: this.userAgent,
        locale: 'en-US',
        viewport: { width: 1366, height: 900 },
      });
      this.context.setDefaultTimeout(this.timeoutMs);
      return this.context;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Loads a URL and returns the rendered HTML in the same shape the plain HTTP
   * fetcher produces, so every downstream rule works unchanged.
   */
  async get(url, { waitFor, waitUntil = 'domcontentloaded', timeoutMs = this.timeoutMs, headers, blockAssets = true } = {}) {
    const context = await this.start();
    const page = await context.newPage();

    try {
      if (headers) await page.setExtraHTTPHeaders(headers);

      // Images and fonts do not decide stock, and skipping them makes each
      // poll several times cheaper for us and for the retailer.
      if (blockAssets) {
        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (type === 'image' || type === 'font' || type === 'media') return route.abort();
          return route.continue();
        });
      }

      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });

      if (waitFor) {
        try {
          await page.waitForSelector(waitFor, { timeout: Math.min(timeoutMs, 15_000) });
        } catch {
          // The selector never appeared, which is itself a signal (it is often
          // the add-to-cart button). Fall through with whatever did render.
          log.debug(`${url}: waitFor "${waitFor}" timed out; using the page as rendered`);
        }
      }

      const body = await page.content();
      const status = response?.status() ?? 0;
      const responseHeaders = response ? await safeHeaders(response) : {};

      return { status, headers: responseHeaders, body, url: page.url() };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }
}

async function safeHeaders(response) {
  try {
    const raw = await response.allHeaders();
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * Finds a Chromium that is already on disk. Playwright's own lookup fails when
 * the installed package and the installed browser build disagree, which is
 * common on managed images that pre-bake the browser.
 */
export function resolveExecutablePath(root = process.env.PLAYWRIGHT_BROWSERS_PATH) {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (!root || !existsSync(root)) return null;

  const candidates = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux', 'headless_shell'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'chrome.exe'],
  ];

  let dirs;
  try {
    // Prefer a full Chromium build over the headless shell: the shell is
    // lighter but drops features some storefronts rely on to render at all.
    const all = readdirSync(root).filter((d) => d.startsWith('chromium'));
    const rank = (d) => (/^chromium-\d+$/.test(d) ? 0 : 1);
    dirs = all.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
  } catch {
    return null;
  }

  for (const dir of dirs) {
    for (const parts of candidates) {
      const full = join(root, dir, ...parts);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
