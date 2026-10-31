/** Local development only: real actors/Python/SQLite, explicitly simulated messaging. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalActors } from 'terse-sdk/dev';
import { RelaycastMessagingClient, type InboxItem } from '@agent-relay/sdk/messaging';
import { createActorTransport } from '../server/generated/index.js';
import { Coordinator } from '../server/coordinator.ts';
import { createAppServer } from '../server/app.ts';
import { SiteRunner } from '../site/runner.ts';
import { hash, studyInputSchema } from '../study/protocol.ts';

const root = process.cwd();
const directory = resolve(process.argv[2] ?? '.local/browser');
const fixtures = resolve(process.argv[3] ?? '.local/sites');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const accessPath = join(directory, 'access.json');
if (!existsSync(accessPath)) writeFileSync(accessPath, JSON.stringify({
  credential: randomBytes(24).toString('base64url'), sessionSecret: randomBytes(32).toString('base64url'),
}), { mode: 0o600 });
const access = JSON.parse(readFileSync(accessPath, 'utf8'));
const port = Number(process.env.PORT ?? 3000);
const origin = new URL(process.env.APP_ORIGIN || `http://localhost:${port}`).origin;

const inputs = ['a', 'b', 'c'].map(letter => {
  const text = readFileSync(join(fixtures, letter, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(text);
  return { site_id: manifest.site_id, manifest_sha256: createHash('sha256').update(text).digest('hex'),
    selected: manifest.acquisitions.filter((a: { role: string }) => a.role === 'selected').map((a: {
      subject_id: string; acquisition_id: string; sha256: string; source: { sha256: string };
    }) => ({ subject_id: a.subject_id, acquisition_id: a.acquisition_id, input_sha256: a.sha256, source_sha256: a.source.sha256 })) };
});
studyInputSchema.parse({ study_id: randomUUID(), title: 'Local fixture', owner_id: 'researcher', sites: inputs });

// Explicit transport prevents inherited managed credentials from being used locally.
const runtime = await startLocalActors({ project: root, entrypoint: 'src/actor.ts', dataDir: join(directory, 'actors'),
  projectId: 'browser-local', apiKey: access.sessionSecret, quiet: true });
const transport = createActorTransport({ projectId: runtime.connection.projectId,
  controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey });

function channel() {
  const queues: Record<string, InboxItem[]> = { coordinator: [], site: [] };
  const endpoint = (name: string, peer: string) => {
    const client = new RelaycastMessagingClient({ agentToken: 'unused-local-simulation', baseUrl: 'https://example.invalid' });
    client.messages.direct = async message => {
      const id = randomUUID();
      const body = { id, messageId: id, text: message.text, from: { id: name } };
      queues[peer].push({ id, recipient: { name: peer }, state: 'queued', attempts: 0, message: body });
      return body;
    };
    client.inbox.list = async () => ({ items: queues[name].slice(0, 100) });
    client.inbox.ack = async ({ inboxItemId }) => {
      queues[name] = queues[name].filter(item => item.id !== inboxItemId);
      return { supported: true, action: 'ack', deliveryId: inboxItemId, messageId: inboxItemId, state: 'read' };
    };
    client.inbox.fail = async ({ inboxItemId }) => {
      queues[name] = queues[name].filter(item => item.id !== inboxItemId);
      return { supported: true, action: 'fail', deliveryId: inboxItemId, messageId: inboxItemId, state: 'failed' };
    };
    client.inbox.defer = async ({ inboxItemId, availableAt }) => {
      const item = queues[name].find(item => item.id === inboxItemId);
      if (item) item.availableAt = availableAt;
      return { supported: true, action: 'defer', deliveryId: inboxItemId, messageId: inboxItemId, state: 'deferred' };
    };
    return client;
  };
  return { coordinator: endpoint('coordinator', 'site'), site: endpoint('site', 'coordinator') };
}

const runners: SiteRunner[] = [];
const coordinator = new Coordinator(inputs.map(input => {
  const letter = input.site_id.slice(-1);
  const datasetRoot = join(fixtures, letter);
  const relay = channel();
  const runner = new SiteRunner({ siteId: input.site_id, coordinatorId: 'coordinator', coordinatorName: 'coordinator',
    datasetRoot, evidenceDir: join(datasetRoot, 'evidence'), projectRoot: root,
    python: resolve(root, '.venv/bin/python'), database: join(directory, `${input.site_id}.sqlite`) }, relay.site);
  // Simulated queues are volatile. Replay durable outboxes after a dev-process restart.
  runner.db.exec('UPDATE outbox SET sent=0');
  runners.push(runner);
  return { siteId: input.site_id, agentId: 'site', agentName: 'site', relay: relay.coordinator,
    ensureReady: async () => {}, readEvidence: async (id: string) => {
      hash.parse(id); return readFileSync(join(datasetRoot, 'evidence', `${id}.png`));
    } };
}), transport);

const stopping = new AbortController();
const workers = [coordinator.run(stopping.signal), ...runners.map(async runner => {
  while (!stopping.signal.aborted) {
    try { await runner.cycle(); } catch { console.error('LOCAL_RUNNER_RETRY'); }
    try { await setTimeout(500, undefined, { signal: stopping.signal }); } catch { break; }
  }
})];
const server = createAppServer({ coordinator, config: { ...access, origin, sites: inputs }, mode: 'local' });
server.listen(port, '0.0.0.0', () => console.log(`LOCAL_STUDY_READY port=${port} credential_file=${accessPath}`));
async function shutdown() {
  stopping.abort();
  const deadline = globalThis.setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), ...workers]);
  runners.forEach(runner => runner.close());
  await runtime.stop();
  clearTimeout(deadline);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
