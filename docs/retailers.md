# Watching major retailers

Notes on what actually works, per retailer, and where the effort is wasted.

## Read this first

**The bot only tells you.** It does not check out, solve CAPTCHAs, or hold a queue slot.
When a drop lands you still have to be at your phone and fast. That is the deal, and it is
worth being clear about it before you build a watchlist around it.

**Big retailers push back.** Best Buy, Walmart, Target and Amazon all run bot management
(Akamai, PerimeterX, and friends). A plain HTTP poll gets a challenge page or a 403 rather
than a product page. Browser mode gets through more often because it *is* a browser, but not
always, and not forever.

**There is a line this project does not cross.** No fingerprint spoofing, no proxy rotation,
no CAPTCHA solving, no pretending to be a browser it is not. Those are the techniques that
get an IP banned and a project like this treated as an attack. If a retailer is determined
to keep you out, the answer is their own stock-notification list, not a bigger hammer.

**Poll gently.** Sub-second polling is not available on purpose, and browser mode is roughly
50x more expensive per check than plain HTTP. Twenty targets hammering one retailer will get
you blocked well before the drop lands. The shipped defaults are deliberately slow.

## Reality check on the PS5 Pro specifically

As of early-to-mid 2026 the PS5 Pro is broadly in stock at most US retailers — it is not the
scarce object the launch made it. If you are just trying to buy one at retail price, check
the store directly before running a bot for weeks.

Where a watcher genuinely earns its keep:

- **Specific bundles or limited editions**, which do still sell out fast.
- **Price drops** — set `maxPrice` and let it tell you when something crosses your number.
- **A restock at one particular retailer** you have a gift card or membership for.
- **Regions where supply is still tight.**

If one of those is your case, the config is worth setting up. If not, one look at Best Buy
will answer your question faster than this will.

## Per retailer

Ordered by how likely you are to get a working watcher out of it.

### Best Buy — official API. Start here.

The one retailer with a documented, public, key-based API. It reports `onlineAvailability`
and `orderable` per SKU, so there is nothing to scrape and nothing to fight.

1. Get a free key at `developer.bestbuy.com`.
2. Put it in `.env` as `BESTBUY_API_KEY=...`.
3. `node src/index.js check bestbuy-api --config config/ps5-pro.json`

This is the only target enabled by default in the shipped watchlist, because it is the only
one that is reliable without tuning. Confirm the JSON shape with `check` before trusting it —
API responses change, and the rules in the config encode assumptions about field names.

### GameStop — usually fine with a plain HTTP poll

Historically the most tolerant of the console retailers. Try `mode: "http"` first; only move
to browser mode if `check` comes back `unknown` on a page you can see is in stock.

### B&H, Newegg — generally workable

Clean markup, real stock wording in the HTML, comparatively relaxed. Newegg carries a lot of
third-party resale listings, so keep `maxPrice` tight or you will get alerts for a $1,100
console.

### PlayStation Direct — worth watching, expect a queue

Sony's own store, and often the first place a genuine restock appears. Drops are usually
fronted by a virtual queue, so what the watcher tells you is "the queue is open", which is
still the signal you want. JS-rendered, so browser mode.

### Target — browser mode, works often enough

Stock state renders client-side and the site runs bot management. Browser mode with a
`waitFor` on the fulfillment buttons gets through a good share of the time. Poll slowly.

### Costco — membership-gated, bundle-heavy

Often lists bundles rather than a bare console, and hides price behind sign-in, so the
`maxPrice` guard may not have anything to read. The shipped entry sets `alertOverPrice` for
that reason.

### Walmart — expect a fight

The most aggressive bot management of the mainstream retailers. It may work; it may serve you
a challenge page indefinitely. If `check` keeps coming back with a challenge, stop poking it
and use Walmart's own "notify me" list. Repeatedly hammering it is how you get an IP block.

### Amazon — realistically, do not bother

Heavy bot management, and their `robots.txt` disallows much of the product path, so the
watcher will skip it by default rather than quietly ignoring the rules. Amazon's own stock
alerts, or a dedicated price tracker, will serve you better than anything here.

## Getting a product URL into the watchlist

You need the real product URL, and SKU numbers change between bundles and regions. Two ways:

**Paste it.** Open the product page, copy the URL, and either edit the config or run:

```bash
node src/index.js add "<url>" --name "PS5 Pro at <retailer>" --max-price 800
node src/index.js check <the-id-it-prints>
```

**Let discovery find it.** The `bestbuy-search` source in the shipped config searches for PS5
Pro listings and, with `autoWatch`, starts watching anything new it finds. That also means a
brand new bundle page appearing is itself an alert — before it ever has stock.

```bash
node src/index.js discover --config config/ps5-pro.json
```

## Tuning a retailer that comes back `unknown`

`check` tells you which of two problems you have.

```bash
node src/index.js check <id> --config config/ps5-pro.json
```

- **`HTTP 403` / a challenge page** — bot management. Try `"mode": "browser"`. If that still
  fails, this retailer is not going to work; use their notification list.
- **`HTTP 200` but `State unknown`** — the page loaded and the rules did not match. Either it
  is JS-rendered (switch to browser mode) or the wording is unusual (write `signals` for it —
  see "Teaching it a stubborn site" in the README).

For a JS-rendered page, the fastest path is often to skip the HTML entirely: open the browser
Network tab, find the JSON the page fetches to decide stock, and point a target straight at
that endpoint with `type: "json"` rules. It is faster than rendering and far more stable than
CSS selectors.

## A realistic setup

Rather than watching nine retailers badly, watch two or three well:

1. **Best Buy via the API** — reliable, cheap, always on.
2. **One or two retailers you would actually buy from**, in browser mode, polling every few
   minutes.
3. **Discovery on**, so a new bundle page gets found without you watching for it.

Then put `NTFY_TOPIC` in `.env` so it reaches your phone, and leave it running somewhere
that stays up.
