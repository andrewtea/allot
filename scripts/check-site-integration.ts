/** Mutates only an already-provisioned disposable gate VM/workspace. No provisioning. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Freestyle } from 'freestyle';
import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';

const configPath = process.argv[2];
if (!configPath) throw new Error('Pass the private integration config path');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  vmId: string;
  relayBaseUrl: string;
  coordinator: { id: string; name: string; token: string };
  site: { id: string; name: string; token: string };
};
const vm = new Freestyle().vms.ref(config.vmId);
const co = new RelaycastMessagingClient({ agentToken: config.coordinator.token, baseUrl: config.relayBaseUrl });
const site = new RelaycastMessagingClient({ agentToken: config.site.token, baseUrl: config.relayBaseUrl });
const root = '/srv/allot';
const observations: unknown[] = [];
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function command(text: string) {
  const result = await vm.linuxUser('root').exec({ command: text, timeoutMs: 300000 });
  if (result.statusCode !== 0) throw new Error(`Gate command failed (${result.statusCode}): ${result.stderr}`);
  return result.stdout ?? '';
}
function record(name: string, details: unknown) {
  const observation = { timestamp: new Date().toISOString(), name, details };
  observations.push(observation);
  console.log(JSON.stringify(observation));
}
async function status() {
  return JSON.parse(await command(`/usr/local/bin/node --input-type=module -e ${quote(`
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync('${root}/state/jobs.sqlite',{readOnly:true});
    console.log(JSON.stringify({
      jobs:db.prepare('SELECT request_id,state,executions FROM jobs').all(),
      outbox:db.prepare('SELECT event_id,sent FROM outbox').all(),
      rejections:db.prepare('SELECT delivery_id,code FROM rejections').all()
    }));db.close();
  `)}`));
}
async function send(request: object) {
  return co.messages.direct({ to: config.site.name, text: JSON.stringify(request), idempotencyKey: randomUUID() });
}
async function results(request: { request_id: string; attempt_id: string; study_id: string }) {
  const accepted = new Map<string, any>();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && accepted.size < 3) {
    for (const item of (await co.inbox.list({ limit: 100 })).items) {
      assert.equal(item.message.from.id, config.site.id);
      const event = JSON.parse(item.message.text);
      if (event.request_id === request.request_id) {
        assert.equal(event.schema_version, 1);
        assert.equal(event.study_id, request.study_id);
        assert.equal(event.attempt_id, request.attempt_id);
        assert.equal(event.site_id, 'site-b');
        assert.notEqual(event.type, 'job_error');
        assert(!/\/srv\/|\/opt\/|\.nii\.gz"\s*:\s*|api_key|relayAgentToken/.test(item.message.text));
        accepted.set(event.message_id, event);
      }
      appendFileSync('.local/integration/received.ndjson', JSON.stringify(event) + '\n', { mode: 0o600, flush: true });
      await co.inbox.ack({ inboxItemId: item.id });
    }
    if (accepted.size < 3) await setTimeout(500);
  }
  assert.equal(accepted.size, 3, 'Expected two scan results and site_finished');
  const events = [...accepted.values()];
  assert.equal(events.find(e => e.type === 'site_finished').payload.selected_count, 2);
  const scans = events.filter(e => e.type === 'scan_result');
  assert.equal(scans.length, 2);
  const corrupt = scans.find(e => e.payload.result.acquisition_id === 'sub-03-test').payload.result;
  const healthy = scans.find(e => e.payload.result.acquisition_id === 'sub-04-test').payload.result;
  assert.equal(corrupt.checks_passed, false);
  assert(corrupt.findings.some((f: any) => f.code === 'INTERNAL_BLANK_SLAB'));
  assert(corrupt.measurements.blank_slab_intervals_z.some((i: number[]) => i[0] === 100 && i[1] === 102));
  assert.equal(healthy.checks_passed, true);
  for (const scan of scans) assert.equal(scan.payload.result.evidence.status, 'ready');
  return events;
}

const initial = await vm.data();
assert.equal(initial.metadata?.purpose, 'integration-gate', 'Refuse to modify a non-gate VM');
record('starting-state', { vmId: config.vmId, state: initial.state, resources: initial.resources });
await vm.start();
try {
  await command(`systemctl stop allot-site 2>/dev/null || true; mkdir -p ${root}/state ${root}/study`);
  for (const file of ['site/runner.ts', 'site/investigation.ts', 'study/protocol.ts', 'site/main.ts', 'site/allot-site.service', 'analysis/integrity.py']) {
    await vm.fs.writeFile(`${root}/${file}`, await readFile(file));
  }
  const siteConfig = {
    siteId: 'site-b', coordinatorId: config.coordinator.id, coordinatorName: config.coordinator.name,
    projectRoot: root, datasetRoot: `${root}/data`, evidenceDir: `${root}/data/evidence`,
    python: '/opt/venv/bin/python', database: `${root}/state/jobs.sqlite`,
    relayBaseUrl: config.relayBaseUrl, relayAgentToken: config.site.token,
  };
  await vm.fs.writeTextFile('/etc/allot-site.json', JSON.stringify(siteConfig));
  await command(`chown ubuntu:ubuntu /etc/allot-site.json; chmod 600 /etc/allot-site.json; chown -R ubuntu:ubuntu ${root}; cp ${root}/site/allot-site.service /etc/systemd/system/allot-site.service; systemctl daemon-reload; systemctl enable allot-site`);
  const manifest = await vm.fs.readFile(`${root}/data/manifest.json`);
  const manifestHash = createHash('sha256').update(manifest).digest('hex');
  const request = () => ({ schema_version: 1, type: 'analyze_site', message_id: randomUUID(), request_id: randomUUID(), study_id: randomUUID(), site_id: 'site-b', attempt_id: randomUUID(), payload: { workflow_version: 'mri-integrity-v1', manifest_sha256: manifestHash } });
  // The test-only driver kills the process at exact durability boundaries.
  // Production code contains no fault-injection switches.
  const driver = `
    import { readFileSync } from 'node:fs';
    import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';
    import { SiteRunner } from './site/runner.ts';
    const config=JSON.parse(readFileSync('/etc/allot-site.json','utf8'));
    const relay=new RelaycastMessagingClient({agentToken:config.relayAgentToken,baseUrl:config.relayBaseUrl});
    const mode=process.argv[2];
    if(mode==='wrong-sender') config.coordinatorId='${config.site.id}';
    if(mode==='before-ack') relay.inbox.ack=async()=>{process.kill(process.pid,'SIGKILL');return new Promise(()=>{});};
    if(mode==='after-send') {
      const send=relay.messages.direct.bind(relay.messages);
      relay.messages.direct=async(input)=>{await send(input);process.kill(process.pid,'SIGKILL');return new Promise(()=>{});};
    }
    const runner=new SiteRunner(config,relay);await runner.cycle();runner.close();
  `;
  await vm.fs.writeTextFile(`${root}/gate-driver.mjs`, driver);
  const first = request();
  await send(first);
  assert((await site.inbox.list()).items.some(i => JSON.parse(i.message.text).request_id === first.request_id));
  record('offline-backlog', { requestId: first.request_id, queued: true });
  const crash = await vm.linuxUser('ubuntu').exec(`/usr/local/bin/node ${root}/gate-driver.mjs before-ack`);
  assert.notEqual(crash.statusCode, 0);
  let ledger = await status();
  assert.equal(ledger.jobs.find((j: any) => j.request_id === first.request_id).executions, 0);
  assert((await site.inbox.list()).items.some(i => JSON.parse(i.message.text).request_id === first.request_id));
  record('crash-before-ack', { durable: true, queued: true, executions: 0 });
  await command('systemctl start allot-site');
  const firstResults = await results(first);
  record('recovered-real-analysis', firstResults.map(e => ({ type: e.type, acquisition: e.payload.result?.acquisition_id, passed: e.payload.result?.checks_passed, elapsedMs: e.payload.elapsed_ms })));
  await command('systemctl stop allot-site');
  await send({ ...first, message_id: randomUUID() });
  await command(`/usr/local/bin/node ${root}/gate-driver.mjs normal`);
  ledger = await status();
  assert.equal(ledger.jobs.find((j: any) => j.request_id === first.request_id).executions, 1);
  assert.equal((await co.inbox.list()).items.length, 0);
  record('duplicate-command', { executions: 1, newResults: 0 });

  const second = request();
  await send(second);
  const sendCrash = await vm.linuxUser('ubuntu').exec(`/usr/local/bin/node ${root}/gate-driver.mjs after-send`);
  assert.notEqual(sendCrash.statusCode, 0);
  ledger = await status();
  assert.equal(ledger.jobs.find((j: any) => j.request_id === second.request_id).state, 'complete');
  assert.equal(ledger.outbox.filter((o: any) => o.event_id.startsWith(second.request_id) && o.sent === 0).length, 3);
  await command('systemctl start allot-site');
  const secondResults = await results(second);
  await command('systemctl stop allot-site');
  ledger = await status();
  assert.equal(ledger.jobs.find((j: any) => j.request_id === second.request_id).executions, 1);
  record('outbox-crash-recovery', { executions: 1, uniqueResults: 3 });

  const previousRejections = new Set(ledger.rejections.map((r: any) => r.delivery_id));
  const previousJobCount = ledger.jobs.length;
  await send({ ...first, message_id: randomUUID(), attempt_id: randomUUID() });
  await send({ ...request(), site_id: 'site-a' });
  await send({ ...request(), payload: { workflow_version: 'mri-integrity-v1', manifest_sha256: '0'.repeat(64) } });
  await send({ ...request(), payload: { command: 'not-allowed' } });
  await command(`/usr/local/bin/node ${root}/gate-driver.mjs normal`);
  // Relay does not enqueue self-DMs. With two identities, temporarily expect
  // the other identity to test a real authenticated but non-allowlisted sender.
  await send(request());
  await command(`/usr/local/bin/node ${root}/gate-driver.mjs wrong-sender`);
  ledger = await status();
  const rejected = ledger.rejections.filter((r: any) => !previousRejections.has(r.delivery_id));
  for (const code of ['REQUEST_ID_CONFLICT', 'WRONG_SITE', 'INPUT_SNAPSHOT_MISMATCH', 'INVALID_REQUEST', 'UNAUTHORIZED_SENDER']) {
    assert(rejected.some((r: any) => r.code === code), `Missing rejection: ${code}`);
  }
  assert.equal(ledger.jobs.length, previousJobCount);
  record('rejected-controls', { codes: rejected.map((r: any) => r.code) });

  // Restart the real supervised process and VM, then exercise another request.
  await command('systemctl start allot-site');
  await vm.pause();
  const frozen = firstResults.find(e => e.type === 'scan_result').payload.result.evidence;
  assert.match(frozen.artifact_id, /^[a-f0-9]{64}$/);
  const bytes = await vm.fs.readFile(`${root}/data/evidence/${frozen.artifact_id}.png`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), frozen.sha256);
  assert(bytes.byteLength <= 150 * 1024);
  assert.equal(Buffer.from(bytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await vm.data()).state, 'paused');
  await mkdir('.amp/in/artifacts', { recursive: true });
  await writeFile('.amp/in/artifacts/freestyle-slab-evidence.png', bytes);
  record('paused-evidence-read', { state: 'paused', bytes: bytes.byteLength, hashMatches: true });
  const third = request();
  await send(third);
  await vm.start();
  const thirdResults = await results(third);
  record('pause-resume-backlog', { completed: true });
  record('analysis-timings-ms', [firstResults, secondResults, thirdResults].map(events => events
    .filter(e => e.type === 'scan_result').map(e => e.payload.elapsed_ms)));
  record('runner-resource-accounting', await command('systemctl show allot-site -p MemoryPeak -p CPUUsageNSec'));
  await command('systemctl stop allot-site');
  await command(`rm -f ${root}/gate-driver.mjs`);
} finally {
  await vm.pause();
  record('final-state', { state: (await vm.data()).state });
  await mkdir('.local/integration', { recursive: true });
  await writeFile('.local/integration/proof.json', JSON.stringify(observations, null, 2));
}
