/** UTC calendar-day helpers for telemetry daily rollups (no DB). */

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isUtcDayString(value) {
  return typeof value === 'string' && UTC_DAY.test(value);
}

/**
 * @param {string} dayIso YYYY-MM-DD (UTC calendar day)
 * @returns {{ y: number, m: number, d: number }}
 */
export function parseUtcDayParts(dayIso) {
  if (!isUtcDayString(dayIso)) {
    const err = new Error('from/to must be UTC dates YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }
  const [y, m, d] = dayIso.split('-').map((n) => Number(n));
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) {
    const err = new Error('Invalid UTC date');
    err.statusCode = 400;
    throw err;
  }
  return { y, m, d };
}

/**
 * Inclusive UTC midnight for that calendar day.
 * @param {string} dayIso
 * @returns {Date}
 */
export function utcDayStart(dayIso) {
  const { y, m, d } = parseUtcDayParts(dayIso);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/**
 * Exclusive end bound for SQL `[start, end)` filtering.
 * @param {string} dayIso
 * @returns {Date}
 */
export function utcDayExclusiveEnd(dayIso) {
  const start = utcDayStart(dayIso);
  return new Date(start.getTime() + 86400000);
}

/**
 * Inclusive list of YYYY-MM-DD strings from fromIso through toIso (UTC).
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {string[]}
 */
export function utcDaysInclusive(fromIso, toIso) {
  parseUtcDayParts(fromIso);
  parseUtcDayParts(toIso);
  const startMs = utcDayStart(fromIso).getTime();
  const endMs = utcDayStart(toIso).getTime();
  if (endMs < startMs) {
    const err = new Error('`to` must be on or after `from`');
    err.statusCode = 400;
    throw err;
  }
  const out = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    const d = new Date(t);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * @param {string} fromIso
 * @param {string} toIso
 * @param {number} maxSpanDays
 */
export function assertUtcRangeWithin(fromIso, toIso, maxSpanDays) {
  const days = utcDaysInclusive(fromIso, toIso);
  if (days.length > maxSpanDays) {
    const err = new Error(`Date range exceeds max of ${maxSpanDays} UTC days`);
    err.statusCode = 400;
    throw err;
  }
  return days;
}
