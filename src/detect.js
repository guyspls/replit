import { resolveSource, parsePrice } from './extract.js';

/**
 * Stock states, ordered by how close they are to "you can own this".
 * The watcher alerts on any forward move through this ladder, which is what
 * turns a plain stock checker into an early-warning system: `absent ->
 * coming_soon` fires days before `-> in_stock` does.
 */
export const STATES = {
  absent: 0, // page 404s — product does not exist yet
  unknown: 1, // page loaded but no signal matched
  coming_soon: 2, // listing is live, not orderable ("notify me")
  preorder: 3, // orderable, ships later
  low_stock: 4, // buyable, site says hurry
  in_stock: 5, // buyable now
};

export const STATE_NAMES = Object.keys(STATES);

export function rank(state) {
  return STATES[state] ?? STATES.unknown;
}

export function isBuyable(state) {
  return rank(state) >= STATES.preorder;
}

const OPS = {
  exists: (values, _expected, source) => source.found,
  missing: (values, _expected, source) => !source.found,
  equals: (values, expected) => values.some((v) => looseEq(v, expected)),
  not_equals: (values, expected) => !values.some((v) => looseEq(v, expected)),
  contains: (values, expected) => values.some((v) => str(v).includes(str(expected).toLowerCase())),
  not_contains: (values, expected) => !values.some((v) => str(v).includes(str(expected).toLowerCase())),
  matches: (values, expected) => {
    const re = toRegExp(expected);
    return values.some((v) => re.test(str(v)));
  },
  not_matches: (values, expected) => {
    const re = toRegExp(expected);
    return !values.some((v) => re.test(str(v)));
  },
  gt: (values, expected) => values.some((v) => num(v) !== null && num(v) > Number(expected)),
  gte: (values, expected) => values.some((v) => num(v) !== null && num(v) >= Number(expected)),
  lt: (values, expected) => values.some((v) => num(v) !== null && num(v) < Number(expected)),
  lte: (values, expected) => values.some((v) => num(v) !== null && num(v) <= Number(expected)),
  truthy: (values) => values.some((v) => Boolean(v) && v !== 'false' && v !== '0'),
  falsy: (values) => values.every((v) => !v || v === 'false' || v === '0'),
};

export const OPERATORS = Object.keys(OPS);

const str = (v) => String(v ?? '').toLowerCase();
const num = (v) => (typeof v === 'number' ? v : parsePrice(v));

function looseEq(a, b) {
  if (a === b) return true;
  return str(a) === str(b);
}

const regexCache = new Map();
function toRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern;
  const key = String(pattern);
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(key, 'i');
    regexCache.set(key, re);
  }
  return re;
}

/** Evaluates a single signal rule against a page. Never throws on bad input. */
export function evaluateRule(page, rule) {
  const op = OPS[rule.op ?? 'exists'];
  if (!op) throw new Error(`unknown operator: ${rule.op}`);
  let source;
  try {
    source = resolveSource(page, rule);
  } catch (err) {
    return { matched: false, error: err.message };
  }
  const matched = Boolean(op(source.values, rule.value, source));
  return { matched, sample: source.values.slice(0, 3) };
}

/**
 * Heuristics applied when a target declares no signals of its own. These lean
 * on schema.org markup first (present on most real storefronts and rarely
 * wrong) and fall back to button/phrase matching.
 */
export const DEFAULT_SIGNALS = {
  in_stock: [
    { type: 'jsonld', path: 'availability', op: 'matches', value: '(InStock|LimitedAvailability|OnlineOnly)\\b' },
    { type: 'text', op: 'matches', value: '\\badd to (cart|bag|basket|trolley)\\b' },
    { type: 'text', op: 'matches', value: '\\b(buy it now|buy now|add to cart)\\b' },
  ],
  low_stock: [
    { type: 'jsonld', path: 'availability', op: 'contains', value: 'LimitedAvailability' },
    { type: 'text', op: 'matches', value: '\\b(only \\d+ left|low stock|hurry|almost (gone|sold out)|\\d+ (items? )?remaining)\\b' },
  ],
  preorder: [
    { type: 'jsonld', path: 'availability', op: 'matches', value: '(PreOrder|PreSale|BackOrder)' },
    { type: 'text', op: 'matches', value: '\\b(pre-?order|reserve (now|yours))\\b' },
  ],
  coming_soon: [
    { type: 'jsonld', path: 'availability', op: 'contains', value: 'ComingSoon' },
    { type: 'text', op: 'matches', value: '\\b(coming soon|notify me|email me when|sign up for updates|back in stock soon|launching soon)\\b' },
  ],
  out_of_stock: [
    { type: 'jsonld', path: 'availability', op: 'matches', value: '(OutOfStock|SoldOut|Discontinued)' },
    { type: 'text', op: 'matches', value: '\\b(out of stock|sold out|currently unavailable|no longer available|temporarily unavailable|out-of-stock)\\b' },
  ],
};

/**
 * Turns a fetched page into a stock state.
 *
 * Resolution is deliberately veto-first: an explicit out-of-stock signal beats
 * a generic "add to cart" string that half of all storefronts ship in a hidden
 * template. An in-stock signal still wins over the veto, because a page that
 * says both is almost always a live product with a sold-out sibling variant.
 */
export function detectState(page, target = {}) {
  const signals = mergeSignals(target.signals);

  if (page.status === 404 || page.status === 410) {
    return { state: 'absent', reasons: [`HTTP ${page.status}`], matched: {} };
  }
  if (page.status >= 400) {
    return { state: 'unknown', reasons: [`HTTP ${page.status}`], matched: {}, degraded: true };
  }

  const matched = {};
  const reasons = [];
  for (const [bucket, rules] of Object.entries(signals)) {
    matched[bucket] = [];
    for (const rule of rules ?? []) {
      const result = evaluateRule(page, rule);
      if (result.error) {
        reasons.push(`rule error (${bucket}): ${result.error}`);
        continue;
      }
      if (result.matched) matched[bucket].push(describeRule(rule));
    }
  }

  const hit = (bucket) => (matched[bucket] ?? []).length > 0;

  let state = 'unknown';
  if (hit('in_stock')) {
    // A page carrying both an add-to-cart and a sold-out string is nearly
    // always a live product with a sold-out sibling variant, so the positive
    // buy signal outranks the veto below.
    state = hit('low_stock') ? 'low_stock' : 'in_stock';
  } else if (hit('preorder')) {
    state = 'preorder';
  } else if (hit('coming_soon')) {
    state = 'coming_soon';
  }

  // `out_of_stock` is a veto bucket rather than a rung on the ladder: with no
  // positive buy signal it pins the state down instead of letting a stray
  // phrase promote it. `coming_soon` survives — a live "notify me" page is
  // still the early warning we want, even while it reads as unavailable.
  if (hit('out_of_stock') && !hit('in_stock') && rank(state) > STATES.coming_soon) {
    reasons.push(`vetoed by out-of-stock signal: ${matched.out_of_stock[0]}`);
    state = 'unknown';
  }

  for (const bucket of ['in_stock', 'low_stock', 'preorder', 'coming_soon']) {
    if (hit(bucket)) reasons.push(`${bucket}: ${matched[bucket][0]}`);
  }

  return { state, reasons, matched };
}

function mergeSignals(custom) {
  if (!custom) return DEFAULT_SIGNALS;
  const merged = {};
  for (const bucket of Object.keys(DEFAULT_SIGNALS)) {
    if (custom[bucket] === null) merged[bucket] = []; // explicit opt-out
    else if (custom[bucket]) merged[bucket] = custom[bucket];
    else if (custom.replaceDefaults) merged[bucket] = [];
    else merged[bucket] = DEFAULT_SIGNALS[bucket];
  }
  return merged;
}

function describeRule(rule) {
  const where = rule.selector ?? rule.path ?? rule.name ?? rule.type;
  return `${where} ${rule.op ?? 'exists'}${rule.value === undefined ? '' : ` "${rule.value}"`}`;
}

/** Best-effort price for the target, used for the max-price guard. */
export function detectPrice(page, target = {}) {
  const rules = target.priceSignals ?? [
    { type: 'jsonld', path: 'price' },
    { type: 'jsonld', path: 'lowPrice' },
    { type: 'selector', selector: '[itemprop="price"]', attr: 'content' },
    { type: 'selector', selector: '[data-price]', attr: 'data-price' },
    { type: 'selector', selector: 'meta[property="product:price:amount"]', attr: 'content' },
  ];
  for (const rule of rules) {
    let source;
    try {
      source = resolveSource(page, rule);
    } catch {
      continue;
    }
    for (const value of source.values) {
      const price = parsePrice(value);
      if (price !== null && price > 0) return price;
    }
  }
  return null;
}

/**
 * Decides whether a state change is worth waking someone up for.
 * Forward movement along the ladder alerts; sliding back is recorded quietly
 * so the next restock alerts again.
 */
export function classifyTransition(previous, next) {
  const from = previous ?? 'unknown';
  if (from === next) return { alert: false, kind: 'same' };

  const delta = rank(next) - rank(from);
  if (delta <= 0) return { alert: false, kind: 'regress' };

  if (isBuyable(next)) {
    return { alert: true, kind: 'buyable', urgency: next === 'preorder' ? 'high' : 'max' };
  }
  return { alert: true, kind: 'early-warning', urgency: 'default' };
}
