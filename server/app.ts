import { createServer } from 'node:http';

/** Bootstrap HTTP surface only: no study routes or provider credentials yet. */
export function createAppServer() {
  return createServer((request, response) => {
    const path = request.url?.split('?')[0];
    let status = 200;
    let body: object;
    if (path !== '/' && path !== '/healthz') {
      status = 404;
      body = { error: 'not_found' };
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      status = 405;
      response.setHeader('Allow', 'GET, HEAD');
      body = { error: 'method_not_allowed' };
    } else {
      body = path === '/healthz'
        ? { status: 'ok' }
        : { service: 'allot', stage: 'bootstrap', message: 'The HTTP server is running. Study workflows are not available yet.' };
    }
    const json = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : json);
  });
}
