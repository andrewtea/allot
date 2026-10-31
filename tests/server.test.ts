import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../server/app.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalActors } from 'terse-sdk/dev';
import { actors, createActorTransport } from '../server/generated/index.js';
import { Coordinator } from '../server/coordinator.ts';
import { sessionToken } from '../server/session.ts';
import { browserConfig, type BrowserConfig, type StudyView } from '../server/studies.ts';
import type { Study } from '../study/state.ts';
import type { SiteConnection } from '../server/coordinator.ts';

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

test('auth-only deployment signs in securely but refuses every study operation without a coordinator', async () => {
  const keys = ['BROWSER_CONFIG', 'APP_ORIGIN', 'DEMO_CREDENTIAL', 'SESSION_SECRET'] as const;
  const previous = keys.map(key => process.env[key]);
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    keys.forEach(key => delete process.env[key]);
    assert.equal(browserConfig(), undefined);
    process.env.APP_ORIGIN = 'https://allot.example';
    assert.throws(browserConfig, { message: 'INVALID_BROWSER_CONFIG' });
    process.env.DEMO_CREDENTIAL = 'test-only-long-demo-credential';
    process.env.SESSION_SECRET = 'test-only-session-secret-at-least-32-characters';
    const config = browserConfig()!;
    assert.deepEqual(config.sites, []);
    process.env.APP_ORIGIN = 'http://allot.example';
    assert.throws(browserConfig, { message: 'INVALID_BROWSER_CONFIG' });
    server = createAppServer({ config });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/session`, { method: 'POST',
      headers: { Origin: config.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: config.credential }) });
    assert.equal(login.status, 200);
    assert(login.headers.get('set-cookie')!.includes('Secure'));
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0], Origin: config.origin, 'Content-Type': 'application/json' };
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers })).json(), {
      authenticated: true, mode: 'unconfigured', sites: [],
    });
    const id = randomUUID();
    for (const [path, method] of [
      ['/api/studies', 'POST'], [`/api/studies/${id}`, 'GET'], [`/api/studies/${id}/start`, 'POST'],
      [`/api/studies/${id}/sites/site-a/retry`, 'POST'], [`/api/studies/${id}/evidence/${'a'.repeat(64)}`, 'GET'],
    ]) {
      const response = await fetch(`${base}${path}`, { method, headers });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'CLOUD_NOT_CONFIGURED' });
    }
    assert.equal((await fetch(`${base}/api/studies/${id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { method: 'DELETE', headers })).status, 200);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test('authenticated HTTP study workflow enforces access, revisions, replay and site retries on real Terse', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'allot-http-'));
  const runtime = await startLocalActors({ project: process.cwd(), entrypoint: 'src/actor.ts', dataDir: directory,
    apiKey: 'local-http-test', quiet: true });
  const transport = createActorTransport({ projectId: runtime.connection.projectId,
    controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey });
  // This test exercises HTTP and actors, not messaging/provider connections.
  const coordinator = new Coordinator([{ siteId: 'site-a' } as SiteConnection], transport);
  const config: BrowserConfig = { origin: 'https://allot.example', credential: 'test-credential-not-for-deployment',
    sessionSecret: 'test-session-signing-material-not-for-deployment', sites: [{ site_id: 'site-a',
      manifest_sha256: 'a'.repeat(64), selected: [{ subject_id: 'subject-one', acquisition_id: 'scan-one',
        input_sha256: 'b'.repeat(64), source_sha256: 'c'.repeat(64) }] }] };
  const server = createAppServer({ coordinator, config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = (path: string, body?: unknown, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: config.origin, Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const id = randomUUID();
    const url = `/api/studies/${id}`;
    assert.equal((await call('/api/studies', { id, title: 'Unauthorized' })).status, 401);
    assert.equal((await call(url)).status, 401);
    assert.equal((await call(`${url}/evidence/${'a'.repeat(64)}`)).status, 401);
    assert.equal((await call('/api/session', { credential: 'wrong' })).status, 401);
    assert.equal((await call('/api/session', { credential: config.credential }, { Origin: 'https://evil.example' })).status, 403);
    const login = await call('/api/session', { credential: config.credential });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert(setCookie.includes(flag));
    cookie = setCookie.split(';')[0];
    assert.equal((await call('/api/session', undefined, { Cookie: `${cookie}forged` })).status, 401);
    assert.equal((await call('/api/session', undefined, { Cookie: `allot_session=${sessionToken(config.sessionSecret, Date.now() - 1000)}` })).status, 401);
    assert.equal((await call('/api/studies', { id, title: 'Invalid', owner_id: 'other' })).status, 400);
    const creation = { id, title: '<script>Not executable</script>' };
    assert.equal((await call('/api/studies', creation)).status, 200);
    assert.equal((await call('/api/studies', creation)).status, 200);
    const draft = await (await call(url)).json() as StudyView;
    assert.equal(draft.lifecycle, 'draft');
    assert.equal(draft.title, creation.title);
    assert(!JSON.stringify(draft).includes('owner_id'));
    const title = { commandId: randomUUID(), revision: 0, title: 'Renamed study' };
    assert.equal((await call(`${url}/title`, title, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(`${url}/title`, title)).status, 200);
    assert.equal((await call(`${url}/title`, title)).status, 200);
    assert.equal((await call(`${url}/title`, { ...title, commandId: randomUUID(), title: 'Competing tab' })).status, 409);
    const start = { commandId: randomUUID(), revision: 1 };
    const results = await Promise.all([call(`${url}/start`, start), call(`${url}/start`, start)]);
    assert(results.every(r => r.status === 200));
    const actor = actors.StudyActor.get(id, transport);
    const running = await actor.work() as Study;
    const view = await (await call(url)).json() as StudyView;
    assert.equal(view.lifecycle, 'running');
    for (const forbidden of ['request_id', 'attempt_id', 'commands', 'seen', config.credential, config.sessionSecret]) {
      assert(!JSON.stringify(view).includes(forbidden));
    }
    assert.equal((await call(`${url}/title`, { ...title, commandId: randomUUID(), revision: view.revision })).status, 409);
    const other = randomUUID();
    await call('/api/studies', { id: other, title: 'Other study' });
    const busy = await call(`/api/studies/${other}/start`, { commandId: randomUUID(), revision: 0 });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'POOL_BUSY');
    assert.equal((await (await call(`/api/studies/${other}`)).json()).lifecycle, 'draft');
    const request = running.sites['site-a'].request;
    await actor.accept({ ...request, message_id: `${request.request_id}:error`, type: 'job_error', payload: { code: 'SITE_ANALYSIS_FAILED' } }, null);
    const blocked = await (await call(url)).json() as StudyView;
    const retry = { commandId: randomUUID(), revision: blocked.revision };
    assert.equal((await call(`${url}/sites/site-a/retry`, retry, { Cookie: '' })).status, 401);
    assert.equal((await call(`${url}/sites/site-a/retry`, retry)).status, 200);
    assert.equal((await call(`${url}/sites/site-a/retry`, retry)).status, 200);
    const retried = await actor.work() as Study;
    assert.notEqual(retried.sites['site-a'].request.attempt_id, request.attempt_id);
    assert.equal(retried.lifecycle, 'running');
    assert.equal((await call(`${url}/evidence/${'a'.repeat(64)}`)).status, 404);
    assert.equal((await call(`${url}/finalize`, { commandId: randomUUID(), revision: retried.revision })).status, 404);
    assert.equal((await call('/.local/browser/access.json')).status, 404);
    await call('/api/session', undefined, {}, 'DELETE');
    cookie = '';
    assert.equal((await call(url)).status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
