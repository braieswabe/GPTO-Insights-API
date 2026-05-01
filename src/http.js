export async function readJson(request) {
  if (!request.body || request.body.length === 0) return {};
  try {
    return JSON.parse(request.body);
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || process.env.GPTO_DASHBOARD_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function corsHeaders(request) {
  const origin = request?.headers?.origin;
  const allowed = allowedOrigins();
  const headers = { vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
    headers['access-control-allow-headers'] =
      'Authorization,Content-Type,x-gpto-user-id,x-gpto-user-role,x-gpto-tenant-id';
  }
  return headers;
}

export function sendJson(response, statusCode, payload, request = null) {
  if (statusCode === 204 || payload === null || payload === undefined) {
    sendNoContent(response, statusCode, request);
    return;
  }
  const body = request?.method === 'HEAD' ? '' : JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...corsHeaders(request),
  });
  response.end(body);
}

export function sendNoContent(response, statusCode, request = null) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...corsHeaders(request),
  });
  response.end();
}

export function sendError(response, error, request = null) {
  const status = error.statusCode || error.status || 500;
  sendJson(response, status, {
    error: status >= 500 ? 'Internal server error' : error.message,
    message: status >= 500 ? error.message : undefined,
  }, request);
}

export function parseRequest(req) {
  if (!req || typeof req.on !== 'function') {
    const headers = req?.headers || {};
    const rawBody = req?.body;
    const body =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody == null
          ? ''
          : JSON.stringify(rawBody);
    return Promise.resolve({
      method: req?.method || 'GET',
      url: new URL(req?.url || '/', `http://${headers.host || 'localhost'}`),
      headers,
      body,
    });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      resolve({
        method: req.method || 'GET',
        url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    });
    req.on('error', reject);
  });
}
