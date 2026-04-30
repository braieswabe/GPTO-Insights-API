import http from 'node:http';
import { loadEnv } from './env.js';
import { parseRequest, sendError, sendJson, sendNoContent } from './http.js';
import { route } from './routes.js';

loadEnv();

const port = Number(process.env.PORT || 4011);
const host = process.env.HOST || '127.0.0.1';

export const server = http.createServer(async (req, res) => {
  let request = null;
  try {
    request = await parseRequest(req);
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
});

if (process.argv[1] && process.argv[1].endsWith('/server.js')) {
  server.listen(port, host, () => {
    console.log(`gpto-insights-gateway listening on http://${host}:${port}`);
  });
}
