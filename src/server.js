import http from 'node:http';
import { loadEnv } from './env.js';
import { parseRequest, sendError, sendNoContent, sendResult } from './http.js';
import { route } from './routes.js';

loadEnv();

const port = Number(process.env.PORT || 4011);
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  let request = null;
  try {
    request = await parseRequest(req);
    if (request.method === 'OPTIONS') {
      sendNoContent(res, 204, request);
      return;
    }
    const result = await route(request);
    sendResult(res, result, request);
  } catch (error) {
    console.error(error);
    sendError(res, error, request);
  }
});

export default server;

if (process.argv[1] && process.argv[1].endsWith('/server.js')) {
  server.listen(port, host, () => {
    console.log(`gpto-insights-gateway listening on http://${host}:${port}`);
  });
}
