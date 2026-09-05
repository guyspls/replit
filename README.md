# scalper-bot

Watches the pages you care about and tells you the moment something becomes buyable —
and, where the site leaks it, *before* that.

It monitors and alerts. It does not buy anything for you: no auto-checkout, no CAPTCHA
solving, no queue jumping. It watches faster than you can and puts a link in your hand.

```
==================================================================
 IN STOCK: Widget X
 State: coming_soon -> in_stock
 Price: $249.00
 Your max: $300.00
==================================================================
```

## Setup, start to finish

```bash
npm install
cp .env.example .env
cp config/watchlist.example.json config/watchlist.json
```

Pick one notification channel. **ntfy is the fastest way onto your phone** — no account,
free, about a minute:

1. Install the *ntfy* app (iOS / Android / web).
2. Subscribe to a topic only you would guess, e.g. `eric-drops-7f3a91`.
3. Put that topic in `.env` as `NTFY_TOPIC=eric-drops-7f3a91`.

```bash
npm run test-notify     # confirm alerts actually reach you
```

Discord, Telegram, Slack, email, and a generic webhook are all supported too — see
`.env.example`. Configure as many as you like; every one fires in parallel, and a dead
channel never blocks the others.

**Watching a console at the big retailers?** There is a ready-made watchlist at
`config/ps5-pro.example.json`, and [`docs/retailers.md`](docs/retailers.md) covers which
retailers actually work, which fight back, and what to do about the ones that do.

## Watching something

```bash
node src/index.js add https://store.example/product/widget --name "Widget X" --max-price 300
node src/index.js check widget-x-1        # does detection work on this page?
npm start                                  # run the watcher
```

`check` is the command you will actually use. It fetches the page once and explains its
verdict, so you can tell "out of stock" apart from "my rules do not match this site":

```
  HTTP           200 in 143ms (84,201 bytes)
  State          coming_soon
  Price          249
  Was            absent
  Conditional    etag "W/8a1f..."
  Custom rules   no — using built-in defaults

  Why:
    - coming_soon: text matches "notify me"

  Next check     1s (hot: state=coming_soon)
```

## The "ahead of time" part

Most stock bots only know two things: in stock, or not. This one tracks a ladder, and
alerts on every forward step:

```
absent  →  coming_soon  →  preorder  →  low_stock / in_stock
 404       listing is     orderable,     buyable now
           live, not      ships later
           orderable
```

That matters because retailers leak in a predictable order. The product page usually goes
live — 404 turning into a real page with a "Notify me" button — hours or days before stock
lands. `absent → coming_soon` is the alert that gets you to the page early; `→ in_stock` is
the one that gets you the item.

Three more things buy you time:

- **Sitemap and search discovery** (below) finds SKUs before they are linked anywhere a
  shopper would see them.
- **`alertOnChange: true`** pings you when the page content shifts at all while the state
  holds. Noisier, but it is often the first sign a drop is being staged.
- **`dropAt`** ramps polling up ahead of a time you already know.

## Speed, when it counts

A flat poll interval either wastes requests for months or misses the drop by 59 seconds.
So the interval adapts:

| Situation | Interval used |
|---|---|
| Normal | `intervalMs` (default 60s) |
| State is `coming_soon` or `preorder` | `hotIntervalMs` (default 3s) |
| Inside a `dropAt` window | `hotIntervalMs` |
| After repeated failures | backs off, capped at 30 min |

```json
{
  "id": "widget",
  "url": "https://store.example/product/widget",
  "dropAt": "2026-09-12T14:00:00Z",
  "hotBeforeMs": 900000,
  "hotIntervalMs": 2000
}
```

Fifteen minutes before the drop it switches to 2-second polling and stays hot for half an
hour after, because sites run late. Conditional requests (`ETag` / `If-Modified-Since`) mean
most of those polls are a 304 with no body, which is how it stays fast without being abusive.

## Teaching it a stubborn site

Most storefronts work with no configuration at all — the defaults read schema.org
`availability` markup first, then fall back to button and phrase matching. When `check`
comes back `unknown` on a page you can plainly see is in stock, write rules for it:

```json
{
  "id": "gpu",
  "url": "https://store.example/gpu",
  "signals": {
    "in_stock": [
      { "type": "selector", "selector": "button[data-testid='add-to-cart']:not([disabled])", "op": "exists" },
      { "type": "json", "path": "product.variants[].available", "op": "truthy" }
    ],
    "out_of_stock": [
      { "type": "selector", "selector": ".sold-out-badge", "op": "exists" }
    ]
  }
}
```

A bucket you define replaces the default for that bucket only; the others still apply. Set
`"replaceDefaults": true` inside `signals` to start from nothing.

**Sources** — `selector` (CSS, plus optional `attr`), `text` (visible text), `body` (raw
HTML), `json` (JSON response, dotted `path`, `[]` maps an array), `jsonld` (schema.org
blocks), `header` (`name`), `status`.

**Operators** — `exists`, `missing`, `equals`, `not_equals`, `contains`, `not_contains`,
`matches` (regex), `not_matches`, `gt`, `gte`, `lt`, `lte`, `truthy`, `falsy`.

**Buckets** — `in_stock`, `low_stock`, `preorder`, `coming_soon`, `out_of_stock`.
`out_of_stock` is a veto, not a rung: it pins the state down rather than counting as
progress. A page carrying both an add-to-cart button and a "Sold out" string reads as in
stock, because that is nearly always a live product with a sold-out sibling variant.

If a page renders its stock state in JavaScript, look for the JSON the page itself fetches
(Network tab, XHR) and point a target straight at that endpoint — it is faster and far more
reliable than the HTML.

## Sites that render stock in JavaScript

Most large retailers serve HTML that says nothing about stock and fill it in client-side. For
those, render the page:

```bash
npm install playwright && npx playwright install chromium
```

```json
{
  "id": "target",
  "url": "https://www.target.com/p/...",
  "mode": "browser",
  "browser": { "waitFor": "[data-test='shippingButton']", "waitUntil": "networkidle" },
  "intervalMs": 180000,
  "hotIntervalMs": 30000
}
```

Try it against any URL without editing the config first:

```bash
node src/index.js check "https://store.example/p/thing" --browser --wait-for "button.add-to-cart"
```

`waitFor` is the important knob: without it you often capture the page a moment before the
availability block renders. One Chromium instance is shared by every browser-mode target,
images and fonts are blocked, and robots.txt is still checked *before* anything launches —
rendering is not a way around the rules.

It is roughly 50x more expensive per check than plain HTTP, so keep browser targets on
minute-scale intervals rather than second-scale ones.

This is a real browser loading a page you could load yourself. There is deliberately no
fingerprint spoofing, proxy rotation, or CAPTCHA solving here. If a retailer still refuses,
the right answer is their own stock-notification list, not a bigger hammer.

## Keeping API keys out of the watchlist

Any `${VAR}` in a target URL or header is expanded from the environment, so a watchlist stays
safe to commit:

```json
{ "url": "https://api.bestbuy.com/v1/products(...)?apiKey=${BESTBUY_API_KEY}&format=json" }
```

If the variable is not set, that one entry is disabled with a warning naming the variable —
the rest of the watchlist still runs.

## Finding things you do not have a URL for yet

```json
"discovery": [
  {
    "id": "retailer-sitemap",
    "kind": "sitemap",
    "url": "https://store.example/sitemap_products.xml",
    "keywords": ["/rtx.?5090/", "founders edition"],
    "exclude": ["refurbished", "bundle"],
    "intervalMs": 900000,
    "autoWatch": true,
    "watchTemplate": { "intervalMs": 30000, "maxPrice": 2199 }
  }
]
```

`kind` is `sitemap`, `search` (a storefront's own JSON search API), or `feed` (any
RSS/Atom — restock trackers, deal feeds, brand blogs). Keywords are plain substrings, or
regexes when wrapped in slashes. With `autoWatch`, a new match immediately becomes a
watched target, so the discovery alert and the stock alert both reach you.

```bash
node src/index.js discover      # run every source once and show what is new
```

## Not getting spammed

Alerts fire on forward transitions only, so a page sitting in stock does not re-alert every
poll. Selling out is recorded silently — and a genuine restock ten minutes later *does*
alert again, which is the whole point.

Runaway alerting is capped by a sliding window (`alertBurst`, default 3 per 10 minutes)
rather than a flat cooldown. A page that oscillates between states every two seconds hits
the ceiling and goes quiet with a log line saying so; a real restock never does.

`maxPrice` suppresses alerts for a listing that is buyable but not at your price — useful
when a page also carries resold or bundled variants. Set `alertOverPrice: true` to hear
about them anyway.

## Running it around the clock

```bash
npm start                       # foreground
LOG_LEVEL=debug npm start       # show every check
```

Any always-on box works — a Raspberry Pi, a VPS, a Replit Always-On repl. State lives in
`data/state.json` and is written atomically, so restarts do not replay old alerts. On
systemd:

```ini
[Service]
WorkingDirectory=/home/you/scalper-bot
ExecStart=/usr/bin/node src/index.js watch
Restart=always
EnvironmentFile=/home/you/scalper-bot/.env
```

## Config reference

| Key | Default | What it does |
|---|---|---|
| `intervalMs` | `60000` | Normal poll interval (floor: 1000) |
| `hotIntervalMs` | `3000` | Interval while hot (floor: 1000) |
| `hotBeforeMs` / `hotAfterMs` | `900000` / `1800000` | Hot window around `dropAt` |
| `jitterRatio` | `0.15` | Randomizes intervals so polls are not perfectly periodic |
| `alertBurst` / `burstWindowMs` | `3` / `600000` | Flap ceiling for state alerts |
| `cooldownMs` | `900000` | Damping for `alertOnChange` alerts |
| `minHostGapMs` | `1000` | Minimum gap between requests to one host |
| `maxConcurrency` | `6` | Targets checked in parallel |
| `respectRobots` | `true` | Honour robots.txt |
| `maxPrice` / `alertOverPrice` | `null` / `false` | Price guard |
| `dropAt` | `null` | Known drop time (ISO 8601) |
| `alwaysHot` | `false` | Stay at `hotIntervalMs` permanently |
| `alertOnChange` | `false` | Alert on any content change |
| `buyUrl` | — | Link the alert points at, if different from the watched URL |
| `headers` | — | Extra request headers for this target (supports `${VAR}`) |
| `mode` | `"http"` | `"browser"` renders the page in headless Chromium |
| `browser.waitFor` | — | CSS selector to wait for before reading a rendered page |
| `browser.waitUntil` | `"domcontentloaded"` | Playwright load state (`networkidle` for slow sites) |

## Behaving well

The defaults are deliberately polite, and it is worth keeping them that way — a bot that
gets your IP blocked cannot tell you anything.

- robots.txt is honoured by default. When a target is disallowed the watcher says so and
  skips it. `respectRobots: false` exists for pages you have permission to poll; it is your
  call to make, not the default.
- Requests to one host never overlap and are spaced by at least `minHostGapMs`.
  `Crawl-delay` is picked up from robots.txt and applied.
- `429` and `503` pause that host, honouring `Retry-After`.
- The user agent identifies the bot honestly rather than impersonating a browser.
- Sub-second polling is not available, on purpose. If you need to be faster than one second,
  what you actually want is the retailer's own notification list or a queue signup.

Poll sanely — one target every few seconds during a drop window is fine; twenty targets
against one retailer at 1s is not, and will get you blocked long before the drop lands.

## Development

```bash
npm test                        # 101 tests, no network required
```

The suite runs a real HTTP server on localhost and drives the full pipeline —
fetch, detect, transition, alert — through it, including 304 handling, robots blocking,
429 backoff, the price guard, and restart persistence.

```
src/
  index.js       CLI
  config.js      watchlist loading + validation
  fetcher.js     HTTP: conditional GETs, per-host pacing, backoff
  robots.js      robots.txt parsing
  extract.js     HTML/JSON/JSON-LD extraction
  detect.js      signal rules + the stock state machine
  scheduler.js   adaptive polling loop
  discovery.js   sitemap / search / feed discovery
  browser.js     optional headless-Chromium rendering
  state.js       durable state
  notify/        one module per channel + fan-out
```
