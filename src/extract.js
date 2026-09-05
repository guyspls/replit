import * as cheerio from 'cheerio';

/**
 * A Page is the normalized view of one fetch that every rule evaluates against.
 * Parsing is lazy and memoized: a 304 or an unchanged body never pays for a DOM.
 */
export function createPage({ url, status, headers = {}, body = '' }) {
  let $ = null;
  let text = null;
  let jsonld = null;
  let json = null;

  return {
    url,
    status,
    headers,
    body,
    /** Parsed DOM, built at most once. */
    get dom() {
      if ($ === null) $ = cheerio.load(body);
      return $;
    },
    /** Visible text with script/style stripped and whitespace collapsed. */
    get text() {
      if (text === null) text = textFromDom(this.dom.root()[0]);
      return text;
    },
    /** Every JSON-LD block on the page, flattened across @graph. */
    get jsonld() {
      if (jsonld === null) jsonld = parseJsonLd(this.dom);
      return jsonld;
    },
    /** The body parsed as JSON, or null when it is not JSON. */
    get json() {
      if (json === null) {
        json = safeJsonParse(body);
        if (json === null) json = false; // memoize the failure
      }
      return json === false ? null : json;
    },
  };
}

const TEXT_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);

/**
 * Reads visible text without mutating the DOM (other rules still need the
 * <script> tags for JSON-LD) and inserts a boundary space at every element
 * edge. Without that boundary, minified markup like
 * `<button>Add to cart</button><span>Sold out</span>` collapses into
 * "Add to cartSold out" and every \b-anchored phrase rule silently misses.
 */
function textFromDom(root) {
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'text') {
      parts.push(node.data ?? '');
      return;
    }
    if (node.type !== 'tag' && node.type !== 'root') return; // script/style/comment
    if (node.name && TEXT_SKIP_TAGS.has(node.name)) return;
    parts.push(' ');
    for (const child of node.children ?? []) walk(child);
    parts.push(' ');
  };
  walk(root);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // one malformed block must not sink the page
    }
    for (const node of flattenJsonLd(parsed)) out.push(node);
  });
  return out;
}

function flattenJsonLd(node, seen = new Set()) {
  const out = [];
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    out.push(n);
    if (Array.isArray(n['@graph'])) for (const item of n['@graph']) walk(item);
    // Offers hang off products and carry the availability we actually care about.
    if (n.offers) walk(n.offers);
  };
  walk(node);
  return out;
}

/**
 * Reads a dotted path out of an object. Supports array indexes (`a.0.b`) and
 * a `[]` wildcard that maps across an array (`items[].sku`).
 */
export function getPath(obj, path) {
  if (!path) return obj;
  let cursor = [obj];
  for (const rawSeg of String(path).split('.')) {
    if (rawSeg === '') continue;
    const wildcard = rawSeg.endsWith('[]');
    const seg = wildcard ? rawSeg.slice(0, -2) : rawSeg;
    const next = [];
    for (const node of cursor) {
      if (node === null || node === undefined) continue;
      const value = seg === '' ? node : node[seg];
      if (value === undefined) continue;
      if (wildcard && Array.isArray(value)) next.push(...value);
      else next.push(value);
    }
    cursor = next;
    if (cursor.length === 0) return undefined;
  }
  return cursor.length === 1 ? cursor[0] : cursor;
}

/** Pulls a number out of "$1,299.99", "USD 34.50", "1.299,99 €" and friends. */
export function parsePrice(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;

  const match = input.replace(/ /g, ' ').match(/-?\d[\d.,\s']*\d|\d/);
  if (!match) return null;
  let s = match[0].replace(/[\s']/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal one.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator only when it splits off 1-2 digits.
    const tail = s.length - lastComma - 1;
    s = tail === 3 ? s.split(',').join('') : s.replace(',', '.');
  } else if (lastDot !== -1) {
    // Retail prices are never quoted to 3 decimals, so a 3-digit tail means
    // the dot was a thousands separator: "1.234" is 1234, not 1.234.
    const tail = s.length - lastDot - 1;
    if (tail === 3) s = s.split('.').join('');
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolves the value a rule should test, based on where the rule points.
 * Returns `{ found, values }` so "selector missing" is distinguishable from
 * "selector present but empty".
 */
export function resolveSource(page, rule) {
  const { type, selector, path, attr } = rule;

  switch (type) {
    case 'text':
      return { found: true, values: [page.text] };

    case 'body':
      return { found: true, values: [page.body] };

    case 'status':
      return { found: true, values: [page.status] };

    case 'header': {
      const key = String(rule.name ?? '').toLowerCase();
      const v = page.headers[key];
      return { found: v !== undefined, values: v === undefined ? [] : [v] };
    }

    case 'selector': {
      const nodes = page.dom(selector);
      if (nodes.length === 0) return { found: false, values: [] };
      const values = nodes
        .toArray()
        .map((el) => (attr ? page.dom(el).attr(attr) : page.dom(el).text().replace(/\s+/g, ' ').trim()))
        .filter((v) => v !== undefined);
      return { found: true, values };
    }

    case 'json': {
      const v = getPath(page.json, path);
      return unwrap(v);
    }

    case 'jsonld': {
      const values = [];
      for (const node of page.jsonld) {
        const v = getPath(node, path);
        if (v === undefined) continue;
        if (Array.isArray(v)) values.push(...v);
        else values.push(v);
      }
      return { found: values.length > 0, values };
    }

    default:
      throw new Error(`unknown signal type: ${type}`);
  }
}

function unwrap(v) {
  if (v === undefined) return { found: false, values: [] };
  if (Array.isArray(v)) return { found: v.length > 0, values: v };
  return { found: true, values: [v] };
}
