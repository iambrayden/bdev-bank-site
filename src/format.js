const TZ = process.env.TZ_DISPLAY || process.env.TZ || 'UTC';

function money(n) {
  const v = Number(n) || 0;
  const s = Math.abs(Math.round(v)).toLocaleString('en-US');
  return (v < 0 ? '-$' : '$') + s;
}

function int(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

function date(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function ago(sec) {
  if (!sec) return '';
  const s = Math.floor(Date.now() / 1000) - sec;
  if (s < 0) return 'in future';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Stringify a raw DB cell for display / CSV.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function pretty(v) {
  const s = cell(v);
  if (!/^[[{]/.test(s.trim())) return s;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// Build a URL that keeps the current query string but overrides some keys.
function qs(query, over) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...over })) if (v !== undefined && v !== null && v !== '' && k !== 'refresh') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

module.exports = { money, int, date, ago, cell, pretty, qs, TZ };
