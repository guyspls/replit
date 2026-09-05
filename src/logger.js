const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `${code}${s}${COLOR.reset}` : s);

let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLevel(level) {
  if (LEVELS[level] === undefined) throw new Error(`unknown log level: ${level}`);
  threshold = LEVELS[level];
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const head = `${paint(COLOR.dim, stamp())} ${paint(COLOR[level], level.padEnd(5))}`;
  const tag = scope ? paint(COLOR.dim, `[${scope}] `) : '';
  const tail = extra === undefined ? '' : ` ${paint(COLOR.dim, inspect(extra))}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${head} ${tag}${msg}${tail}\n`);
}

function inspect(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope) {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
  };
}

/** Loud, unmissable banner for the moment something actually becomes buyable. */
export function banner(lines, maxWidth = 96) {
  const clipped = lines.map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth - 1)}…` : l));
  const width = Math.max(...clipped.map((l) => l.length)) + 2;
  const bar = '='.repeat(width);
  const body = clipped.map((l) => ` ${l.padEnd(width - 1)}`).join('\n');
  process.stdout.write(`\n${paint(COLOR.green + COLOR.bold, `${bar}\n${body}\n${bar}`)}\n\n`);
}

export const colors = COLOR;
