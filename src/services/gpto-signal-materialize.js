/**
 * Calls GPTO Suite POST /api/internal/signals/materialize before gateway cache prewarm.
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ skipped: true, message: string } | { skipped: false, body: unknown }>}
 */
export async function materializeSignalsOnGptoSuite(body = {}) {
  const base = process.env.GPTO_DASHBOARD_BASE_URL?.replace(/\/+$/, '');
  const token = process.env.GPTO_SIGNAL_MATERIALIZE_TOKEN;
  if (!base || !token) {
    return {
      skipped: true,
      message:
        'Signal materialize skipped: set both GPTO_DASHBOARD_BASE_URL and GPTO_SIGNAL_MATERIALIZE_TOKEN to run before prewarm.',
    };
  }

  const rangesFromEnv = (process.env.GPTO_MATERIALIZE_RANGES || '7d')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s === '7d' || s === '30d');
  const rangesFromBody = Array.isArray(body.ranges)
    ? body.ranges.filter((r) => r === '7d' || r === '30d')
    : null;
  const ranges =
    rangesFromBody && rangesFromBody.length > 0 ? rangesFromBody : rangesFromEnv.length > 0 ? rangesFromEnv : ['7d'];

  const payload = {
    siteId: body.siteId ?? null,
    ranges,
  };

  const timeoutMs = Math.max(5000, Number(process.env.GPTO_SIGNAL_MATERIALIZE_TIMEOUT_MS || 110000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/api/internal/signals/materialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { parseError: true, raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      throw new Error(`GPTO materialize HTTP ${res.status}: ${String(text).slice(0, 800)}`);
    }
    if (json && json.ok === false) {
      throw new Error(json.message || 'GPTO materialize returned ok: false');
    }
    return { skipped: false, body: json };
  } finally {
    clearTimeout(timer);
  }
}
