import { sendError, sendJson, sendNoContent } from '../src/http.js';
import { route } from '../src/routes.js';
import { loadEnv } from '../src/env.js';

loadEnv();

function normalizePathname(pathname) {
  if (pathname.startsWith('/api/')) return pathname.slice(4) || '/';
  if (pathname === '/api') return '/';
  return pathname;
}

function createRequest(req) {
  const headers = req.headers || {};
  const url = new URL(req.url || '/', `https://${headers.host || 'localhost'}`);
  url.pathname = normalizePathname(url.pathname);
  const rawBody = req.body;
  const body =
    typeof rawBody === 'string'
      ? rawBody
      : rawBody == null
        ? ''
        : JSON.stringify(rawBody);
  return {
    method: req.method || 'GET',
    url,
    headers,
    body,
  };
}

export default async function handler(req, res) {
  let request = null;
  try {
    request = createRequest(req);
    if (request.method === 'OPTIONS') {
      sendNoContent(res, 204, request);
      return;
    }
    const result = await route(request);
    sendJson(res, result.status, result.body, request);
  } catch (error) {
    console.error(error);
    sendError(res, error, request);
  }
}
