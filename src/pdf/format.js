export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(value)}/100`;
}

export function formatPercent(value, { assumeFraction = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const percent = assumeFraction && Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(1)}%`;
}

export function formatDateTime(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toISOString().slice(0, 10);
}

export function rangeLabel(rangeKey, start, end) {
  if (rangeKey === 'custom') return `${formatDateTime(start)} to ${formatDateTime(end)}`;
  return rangeKey === '30d' ? 'Last 30 days' : 'Last 7 days';
}

export function shorten(value, max = 90) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

export function sentenceCase(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').trim();
  if (!text) return '-';
  return text.charAt(0).toUpperCase() + text.slice(1);
}
