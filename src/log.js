// JSON-lines logger that never prints PII, tokens or signing URLs.

const SENSITIVE = /(email|phone|first_?name|last_?name|share_?link|signing_?url|url|token|secret|authorization|password|ip|user_?agent)/i;

export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { message: value.message, name: value.name };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level, msg, fields) {
  if (process.env.LOG_SILENT === '1') return;
  const line = { t: new Date().toISOString(), level, msg, ...redact(fields ?? {}) };
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}

export const log = {
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};
