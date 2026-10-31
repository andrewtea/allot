import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../server/app.ts';

test('bootstrap HTTP contract exposes liveness, not application readiness', async () => {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/healthz?probe=render`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { status: 'ok' });
    const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), health.headers.get('content-length'));
    assert.equal(await head.text(), '');
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.deepEqual(await home.json(), {
      service: 'allot', stage: 'bootstrap',
      message: 'The HTTP server is running. Study workflows are not available yet.',
    });
    for (const path of ['/healthz', '/']) {
      const write = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      assert.equal(write.status, 405);
      assert.equal(write.headers.get('allow'), 'GET, HEAD');
      assert.deepEqual(await write.json(), { error: 'method_not_allowed' });
    }
    for (const path of ['/studies/private', '/.env', '/healthz/extra']) {
      const missing = await fetch(`${base}${path}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'not_found' });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
