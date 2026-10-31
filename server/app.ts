import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { hash, siteId } from '../study/protocol.ts';
import type { Study } from '../study/state.ts';
import type { Coordinator } from './coordinator.ts';
import { studyActor, studyView, type BrowserConfig } from './studies.ts';
import { authenticated, sameSecret, sessionCookie, sessionToken } from './session.ts';

const commandSchema = z.object({ commandId: z.uuid(), revision: z.number().int().nonnegative() }).strict();
const createSchema = z.object({ id: z.uuid(), title: z.string().trim().min(1).max(160) }).strict();
const titleSchema = commandSchema.extend({ title: createSchema.shape.title });
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function jsonBody(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw new HttpError(413, 'REQUEST_TOO_LARGE');
  }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'INVALID_REQUEST'); }
}

function send(response: ServerResponse, status: number, body: unknown, head = false) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  response.end(head ? undefined : text);
}

export interface AppOptions {
  coordinator?: Coordinator;
  config: BrowserConfig;
  mode?: 'local';
  publicDir?: string;
}

/** Without explicit browser configuration the deployed bootstrap stays credential-free. */
export function createAppServer(options?: AppOptions) {
  let failedLogins = 0;
  let loginWindow = Date.now();
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const path = request.url?.split('?')[0];
    if (options && path !== '/healthz') {
      const { config, coordinator } = options;
      try {
        if (!path) throw new HttpError(404, 'NOT_FOUND');
        if (!path.startsWith('/api/')) {
          if (!['GET', 'HEAD'].includes(request.method!)) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
          const file = path === '/' || /^\/studies\/[0-9a-f-]{36}$/.test(path) ? '/index.html' : path;
          if (!/^\/(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file)) throw new HttpError(404, 'NOT_FOUND');
          const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2' };
          let bytes: Buffer;
          try { bytes = await readFile(resolve(options.publicDir ?? 'web/dist', `.${file}`)); }
          catch { throw new HttpError(404, 'UI_BUILD_REQUIRED'); }
          response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          response.writeHead(200, { 'Content-Type': types[file.split('.').at(-1)!] ?? 'application/octet-stream', 'Content-Length': bytes.length });
          response.end(request.method === 'HEAD' ? undefined : bytes);
          return;
        }
        // The explicit public origin, not untrusted proxy/Host headers, controls CSRF and secure cookies.
        if (request.method !== 'GET' && request.headers.origin !== config.origin) throw new HttpError(403, 'ORIGIN_REJECTED');
        const secure = config.origin.startsWith('https:');
        if (path === '/api/session' && request.method === 'POST') {
          if (Date.now() - loginWindow > 60_000) { failedLogins = 0; loginWindow = Date.now(); }
          if (failedLogins >= 10) throw new HttpError(429, 'TRY_LATER');
          const body = z.object({ credential: z.string().max(256) }).strict().parse(await jsonBody(request));
          if (!sameSecret(body.credential, config.credential)) { failedLogins++; throw new HttpError(401, 'INVALID_CREDENTIAL'); }
          response.setHeader('Set-Cookie', sessionCookie(sessionToken(config.sessionSecret), secure));
          send(response, 200, { authenticated: true }); return;
        }
        if (!authenticated(request, config.sessionSecret)) throw new HttpError(401, 'SIGN_IN_REQUIRED');
        if (path === '/api/session' && request.method === 'DELETE') {
          response.setHeader('Set-Cookie', sessionCookie('', secure, 0));
          send(response, 200, { authenticated: false }); return;
        }
        if (path === '/api/session' && request.method === 'GET') {
          send(response, 200, { authenticated: true, mode: coordinator ? options.mode ?? 'managed' : 'unconfigured',
            sites: config.sites.map(s => ({ id: s.site_id, selected: s.selected.length })) }); return;
        }
        if (!coordinator) throw new HttpError(503, 'CLOUD_NOT_CONFIGURED');
        if (path === '/api/studies' && request.method === 'POST') {
          const body = createSchema.parse(await jsonBody(request));
          const result = await coordinator.create({ study_id: body.id, title: body.title, owner_id: 'researcher', sites: config.sites });
          send(response, result.ok ? 200 : 409, { ...result, id: body.id }); return;
        }
        const match = /^\/api\/studies\/([^/]+)(?:\/(.*))?$/.exec(path);
        if (!match || !z.uuid().safeParse(match[1]).success) throw new HttpError(404, 'NOT_FOUND');
        const [, id, action] = match;
        const actor = studyActor(coordinator, id);
        const study = await actor.work() as Study | null;
        if (!study || study.input.owner_id !== 'researcher') throw new HttpError(404, 'NOT_FOUND');
        if (!action && request.method === 'GET') { send(response, 200, studyView(study)); return; }
        if (action?.startsWith('evidence/') && request.method === 'GET') {
          const artifact = action.slice(9);
          if (!hash.safeParse(artifact).success || !Object.hasOwn(study.evidence, artifact)) throw new HttpError(404, 'NOT_FOUND');
          const bytes = Buffer.from(study.evidence[artifact], 'base64');
          response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
          response.end(bytes); return;
        }
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const raw = await jsonBody(request);
        if (action === 'title') {
          const body = titleSchema.parse(raw);
          const result = await actor.updateTitle(body.commandId, body.title, body.revision);
          send(response, result.ok ? 200 : 409, result); return;
        }
        const body = commandSchema.parse(raw);
        const retry = /^sites\/(site-[a-z])\/retry$/.exec(action ?? '');
        const result = action === 'start' ? await coordinator.start(id, body.commandId, body.revision)
          : retry ? await actor.retrySite(body.commandId, siteId.parse(retry[1]), body.revision) : null;
        if (!result) throw new HttpError(404, 'NOT_FOUND');
        send(response, result.ok ? 200 : 409, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 503;
        const code = error instanceof HttpError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE';
        send(response, status, { error: code });
      }
      return;
    }
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
