import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalActors } from 'terse-sdk/dev';
import { RelaycastMessagingClient, type InboxItem } from '@agent-relay/sdk/messaging';
import { actors, createActorTransport } from '../server/generated/index.js';
import { Coordinator, type SiteConnection } from '../server/coordinator.ts';
import { studyInputSchema, type StudyInput, type ScanResult } from '../study/protocol.ts';
import type { Study } from '../study/state.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=';
const artifact = createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex');
const inputHash = '1'.repeat(64);
const sourceHash = '2'.repeat(64);
const input = (study_id = randomUUID()): StudyInput => ({ study_id, title: 'Durable study', owner_id: 'researcher',
  sites: [{ site_id: 'site-b', manifest_sha256: '3'.repeat(64), selected: [
    { acquisition_id: 'scan-one', subject_id: 'subject-one', input_sha256: inputHash, source_sha256: sourceHash },
    { acquisition_id: 'scan-two', subject_id: 'subject-two', input_sha256: inputHash, source_sha256: sourceHash },
  ] }] });

function result(acquisition_id: string, subject_id: string): ScanResult {
  return { schema_version: 1, site_id: 'site-b', acquisition_id, subject_id, input_sha256: inputHash,
    checks_passed: true, findings: [], measurements: { orientation: ['R', 'A', 'S'], shape: [12, 16, 18],
      voxel_spacing_mm: [2, 3, 4], nonfinite_count: 0, nonfinite_fraction: 0, foreground_fraction: 0.4,
      foreground_bbox_extent_mm: [16, 30, 48], intensity_window: [0, 100], blank_slab_intervals_z: [] },
    evidence: { status: 'ready', artifact_id: artifact, sha256: artifact, media_type: 'image/png',
      bytes: Buffer.from(png, 'base64').length, intensity_window: [0, 100],
      slices: [{ plane: 'sagittal', axis: 0, index: 6 }, { plane: 'coronal', axis: 1, index: 8 }, { plane: 'axial', axis: 2, index: 9 }] },
    provenance: { pipeline_version: 'mri-integrity-v1', parameters: { percentiles: [2, 98], foreground_threshold: 0.1,
      supported_slice_fraction: 0.01, minimum_blank_run: 2 }, packages: { python: '3.12', nibabel: '5', numpy: '2', matplotlib: '3', pillow: '11' },
      timestamp: '2026-10-31T12:00:00+00:00', tool_exit_status: 0,
      source: { dataset: 'Test fixture', version: '1', git_commit: 'a'.repeat(40), doi: 'test', license: 'CC0', authors: 'Test',
        publication: 'https://example.org/fixture', acquisition: 'source.nii.gz', sha256: sourceHash }, synthetic_transformation: null } };
}

test('real Terse actors preserve reservations, accepted evidence and retry arbitration across restart', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'allot-actors-'));
  const options = { project: process.cwd(), entrypoint: 'src/actor.ts', dataDir: directory, projectId: 'study-test', apiKey: 'local-test-only', quiet: true };
  let runtime = await startLocalActors(options);
  const transport = () => createActorTransport({ projectId: runtime.connection.projectId,
    controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey });
  const snapshot = async (id: string) => await actors.StudyActor.get(id, transport()).work() as Study;
  const previousUrl = process.env.TERSE_ACTOR_URL;
  const previousKey = process.env.TERSE_API_KEY;
  try {
    const data = input();
    const registry = actors.DemoRegistryActor.get('demo', transport());
    const actor = actors.StudyActor.get(data.study_id, transport());
    await assert.rejects(actors.StudyActor.get(data.study_id, createActorTransport({
      projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl,
    })).work());
    assert.equal((await actor.initialize(data)).code, 'CREATED');
    assert.equal((await actor.initialize(data)).code, 'EXISTS');
    await registry.register(data.study_id);
    const command = randomUUID();
    await registry.reserve(data.study_id, command, 0);
    const starts = await Promise.all([actor.start(command, 0), actor.start(command, 0)]);
    assert.deepEqual(starts[0], starts[1]);
    const other = input();
    await actors.StudyActor.get(other.study_id, transport()).initialize(other);
    await registry.register(other.study_id);
    assert.equal((await registry.reserve(other.study_id, randomUUID(), 0)).code, 'POOL_BUSY');
    assert.equal((await snapshot(other.study_id)).lifecycle, 'draft');
    const request = (await snapshot(data.study_id)).sites['site-b'].request;
    const event = (type: string, suffix: string, payload: unknown, req = request) => ({ ...req,
      type, message_id: `${req.request_id}:${suffix}`, payload });
    const finish = event('site_finished', 'finished', { selected_count: 2 });
    await actor.accept(finish, null);
    assert.equal((await snapshot(data.study_id)).lifecycle, 'running', 'Early completion must not hide missing scans');
    const firstResult = result('scan-one', 'subject-one');
    const first = event('scan_result', 'scan-one', { result: firstResult, elapsed_ms: 20 });
    const wrong = structuredClone(firstResult);
    wrong.provenance.source.sha256 = '4'.repeat(64);
    assert.equal(await actor.accept(event('scan_result', 'scan-one', { result: wrong, elapsed_ms: 20 }), png), 'INPUT_MISMATCH');
    assert.equal(await actor.accept(first, 'AAAA'), 'INVALID_EVIDENCE');
    assert.equal(await actor.accept(first, png), 'ACCEPTED');
    const revision = (await snapshot(data.study_id)).revision;
    assert.equal(await actor.accept(first, null), 'DUPLICATE', 'Replay needs no VM or PNG fetch');
    assert.equal((await snapshot(data.study_id)).revision, revision);
    assert.equal(await actor.accept({ ...first, payload: { result: firstResult, elapsed_ms: 21 } }, png), 'EVENT_CONFLICT');
    await actor.accept(event('job_error', 'error', { code: 'SITE_ANALYSIS_FAILED' }), null);
    assert.equal((await snapshot(data.study_id)).lifecycle, 'blocked');
    const retry = randomUUID();
    const blockedRevision = (await snapshot(data.study_id)).revision;
    const retried = await actor.retrySite(retry, 'site-b', blockedRevision);
    assert.equal(retried.code, 'RETRYING');
    assert.deepEqual(await actor.retrySite(retry, 'site-b', blockedRevision), retried);
    assert.equal(await actor.accept(finish, null), 'STALE_ATTEMPT');
    const newRequest = (await snapshot(data.study_id)).sites['site-b'].request;
    assert.notEqual(newRequest.attempt_id, request.attempt_id);
    assert.equal((await snapshot(data.study_id)).sites['site-b'].results['scan-one'].input_sha256, inputHash);
    await actor.accept(event('site_finished', 'finished', { selected_count: 2 }, newRequest), null);
    const second = result('scan-two', 'subject-two');
    second.evidence = { status: 'missing', error: 'PREVIEW_FAILED' };
    await actor.accept(event('scan_result', 'scan-two', { result: second, elapsed_ms: 30 }, newRequest), null);
    assert.equal((await snapshot(data.study_id)).sites['site-b'].error, 'PREVIEW_MISSING');
    await actor.retrySite(randomUUID(), 'site-b', (await snapshot(data.study_id)).revision);
    const finalRequest = (await snapshot(data.study_id)).sites['site-b'].request;
    await actor.accept(event('scan_result', 'scan-two', { result: result('scan-two', 'subject-two'), elapsed_ms: 30 }, finalRequest), png);
    await actor.accept(event('site_finished', 'finished', { selected_count: 2 }, finalRequest), null);
    const complete = await snapshot(data.study_id);
    assert.equal(complete.lifecycle, 'ready_to_finalize');
    assert.equal(complete.evidence[artifact], png);
    process.env.TERSE_ACTOR_URL = `${runtime.connection.controlPlaneUrl}/v1/projects/study-test/actors`;
    process.env.TERSE_API_KEY = 'local-test-only';
    const grant = await actors.StudyActor.prepareWebsocket({ actorId: data.study_id, metadata: { role: 'viewer' } });
    const socket = new WebSocket(grant.websocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Viewer socket timeout')); }, 5000);
      socket.onmessage = message => {
        try {
          assert.deepEqual(JSON.parse(String(message.data)), { revision: complete.revision });
          socket.send(JSON.stringify({ type: 'snapshot' }));
        } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
      };
      socket.onclose = event => {
        clearTimeout(timer);
        try { assert.equal(event.code, 4003); resolve(); } catch (error) { reject(error); }
      };
    });
    assert.deepEqual(await snapshot(data.study_id), complete, 'Viewer messages must not mutate state');
    await runtime.stop();
    runtime = await startLocalActors(options);
    assert.deepEqual(await snapshot(data.study_id), complete);
    assert.equal((await actors.DemoRegistryActor.get('demo', transport()).work()).reservation?.study_id, data.study_id);
    assert.equal(studyInputSchema.safeParse({ ...data, sites: [{ ...data.sites[0], selected: [{ ...data.sites[0].selected[0], acquisition_id: '__proto__' }] }] }).success, false);
  } finally {
    if (previousUrl === undefined) delete process.env.TERSE_ACTOR_URL; else process.env.TERSE_ACTOR_URL = previousUrl;
    if (previousKey === undefined) delete process.env.TERSE_API_KEY; else process.env.TERSE_API_KEY = previousKey;
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('coordinator resumes durable intent and ACKs only persisted results across delivery failures', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'allot-coordinator-'));
  const runtime = await startLocalActors({ project: process.cwd(), entrypoint: 'src/actor.ts', dataDir: directory, quiet: true });
  const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl });
  try {
    const data = input();
    const actor = actors.StudyActor.get(data.study_id, transport);
    const snapshot = async () => await actor.work() as Study;
    let inbox: InboxItem[] = [];
    const enqueue = (body: unknown, from = 'trusted-site') => inbox.push({ id: randomUUID(), recipient: { name: 'coordinator' },
      state: 'queued', attempts: 0, message: { id: randomUUID(), messageId: randomUUID(), text: JSON.stringify(body), from: { id: from } } });
    const relay = new RelaycastMessagingClient({ agentToken: 'test-only', baseUrl: 'https://example.invalid' });
    const sent: string[] = [];
    let loseConfirmation = true;
    relay.messages.direct = async message => {
      sent.push(message.text);
      if (loseConfirmation) throw new Error('Lost send confirmation');
      return { id: message.idempotencyKey!, messageId: message.idempotencyKey!, text: message.text, from: { id: 'coordinator' } };
    };
    relay.inbox.list = async () => ({ items: inbox.slice(0, 100) });
    const rejected: string[] = [];
    relay.inbox.fail = async ({ inboxItemId, error }) => {
      rejected.push(error); inbox = inbox.filter(item => item.id !== inboxItemId);
      return { supported: true, action: 'fail', deliveryId: inboxItemId, messageId: inboxItemId, state: 'failed' };
    };
    // Deterministic transport failure injection, not a claim about live Relay.
    relay.inbox.defer = async () => { throw new Error('Connection lost'); };
    let loseAck = true;
    relay.inbox.ack = async ({ inboxItemId }) => {
      const event = JSON.parse(inbox.find(item => item.id === inboxItemId)!.message.text);
      assert((await snapshot()).seen[event.message_id], 'ACK must follow actor commit');
      if (loseAck) throw new Error('Lost ACK');
      inbox = inbox.filter(item => item.id !== inboxItemId);
      return { supported: true, action: 'ack', deliveryId: inboxItemId, messageId: inboxItemId, state: 'read' };
    };
    let evidenceAvailable = true;
    const site: SiteConnection = { siteId: 'site-b', agentId: 'trusted-site', agentName: 'site-b', relay,
      ensureReady: async () => {}, readEvidence: async id => {
        assert.equal(id, artifact);
        if (!evidenceAvailable) throw new Error('VM unavailable');
        return Buffer.from(png, 'base64');
      } };
    const offlineRelay = new RelaycastMessagingClient({ agentToken: 'test-only', baseUrl: 'https://example.invalid' });
    offlineRelay.inbox.list = async () => { throw new Error('Other workspace unavailable'); };
    const sites = [site, { ...site, siteId: 'site-c', relay: offlineRelay }];
    const logs: string[] = [];
    const coordinator = () => new Coordinator(sites, transport, code => logs.push(code));
    let worker = coordinator();
    assert.equal((await worker.create(data)).ok, true);
    assert.equal((await worker.start(data.study_id, randomUUID(), 99)).code, 'CONFLICT');
    const registry = actors.DemoRegistryActor.get('demo', transport);
    assert.equal((await registry.work()).reservation, null, 'Rejected start must release reservation');
    const command = randomUUID();
    await registry.reserve(data.study_id, command, 0); // Crash boundary before StudyActor.start.
    await worker.cycle();
    assert.equal((await snapshot()).lifecycle, 'running');
    assert.equal((await snapshot()).sites['site-b'].sent_at, null);
    loseConfirmation = false;
    worker = coordinator();
    await worker.cycle();
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1], 'A restart must resend the same request/attempt');
    assert((await snapshot()).sites['site-b'].sent_at);
    const nextStudy = input();
    await worker.create(nextStudy);
    assert.equal((await worker.start(nextStudy.study_id, randomUUID(), 0)).code, 'POOL_BUSY');
    const request = JSON.parse(sent[0]);
    const event = (type: string, suffix: string, payload: unknown) => ({ ...request, type, message_id: `${request.request_id}:${suffix}`, payload });
    const first = event('scan_result', 'scan-one', { result: result('scan-one', 'subject-one'), elapsed_ms: 3 });
    enqueue(first, 'impostor');
    enqueue({ ...first, site_id: 'site-a' });
    enqueue({ invalid: 'x'.repeat(70_000) });
    enqueue(first);
    await worker.cycle();
    assert.deepEqual(rejected, ['UNAUTHORIZED_SENDER', 'WRONG_DESTINATION', 'INVALID_EVENT']);
    assert.equal(inbox.length, 1);
    assert.equal((await snapshot()).evidence[artifact], png);
    evidenceAvailable = false;
    loseAck = false;
    worker = coordinator();
    const revision = (await snapshot()).revision;
    await worker.cycle();
    assert.equal(inbox.length, 0, 'Persisted duplicate must ACK even with VM offline');
    assert.equal((await snapshot()).revision, revision);
    enqueue(event('site_finished', 'finished', { selected_count: 2 }));
    enqueue(event('scan_result', 'scan-two', { result: result('scan-two', 'subject-two'), elapsed_ms: 5 }));
    await worker.cycle();
    assert.equal((await snapshot()).lifecycle, 'running');
    assert.equal(inbox.length, 1, 'Transient evidence failure must remain retryable');
    evidenceAvailable = true;
    await worker.cycle();
    assert.equal((await snapshot()).lifecycle, 'ready_to_finalize');
    for (let i = 0; i < 205; i++) enqueue(first);
    await worker.cycle(); await worker.cycle(); await worker.cycle();
    assert.equal(inbox.length, 0, 'Drain all pages after restart');
    assert.equal(Object.keys((await snapshot()).sites['site-b'].results).length, 2);
    assert(logs.includes('COORDINATOR_INBOX_RETRY'), 'Other site outage was exercised');
    const completed = await snapshot();
    assert.equal((await registry.work()).reservation, null, 'Completed analysis releases the pool');
    assert.equal((await worker.start(data.study_id, command, 0)).code, 'STARTED', 'Start replay still succeeds after release');
    assert.equal((await registry.work()).reservation, null, 'Replay must not reacquire the pool');
    assert.equal((await worker.start(nextStudy.study_id, randomUUID(), 0)).code, 'STARTED');
    await registry.releaseReservation(data.study_id, command, 0);
    assert.equal((await registry.work()).reservation?.study_id, nextStudy.study_id, 'Stale release cannot unlock a newer run');
    assert.deepEqual(await snapshot(), completed, 'A new study preserves previous results and evidence');
    const nextActor = actors.StudyActor.get(nextStudy.study_id, transport);
    const nextRequest = (await nextActor.work() as Study).sites['site-b'].request;
    const nextEvent = (type: string, suffix: string, payload: unknown) => ({ ...nextRequest, type,
      message_id: `${nextRequest.request_id}:${suffix}`, payload });
    await nextActor.accept(nextEvent('job_error', 'error', { code: 'SITE_ANALYSIS_FAILED' }), null);
    await worker.cycle();
    assert.equal((await registry.work()).reservation?.study_id, nextStudy.study_id, 'Failed analysis keeps its reservation for retry');
    await nextActor.retrySite(randomUUID(), 'site-b', (await nextActor.work() as Study).revision);
    const retry = (await nextActor.work() as Study).sites['site-b'].request;
    const retryEvent = (type: string, suffix: string, payload: unknown) => ({ ...retry, type,
      message_id: `${retry.request_id}:${suffix}`, payload });
    const flagged = result('scan-one', 'subject-one');
    flagged.checks_passed = false;
    flagged.findings = [{ code: 'INTERNAL_BLANK_SLAB', intervals_z: [[4, 6]] }];
    await nextActor.accept(retryEvent('scan_result', 'scan-one', { result: flagged, elapsed_ms: 3 }), png);
    await nextActor.accept(retryEvent('site_finished', 'finished', { selected_count: 2 }), null);
    await worker.cycle();
    assert.equal((await registry.work()).reservation?.study_id, nextStudy.study_id, 'Early completion cannot release missing results');
    await nextActor.accept(retryEvent('scan_result', 'scan-two', { result: result('scan-two', 'subject-two'), elapsed_ms: 3 }), png);
    await worker.cycle();
    assert.equal((await nextActor.work() as Study).lifecycle, 'needs_review');
    assert.equal((await registry.work()).reservation, null, 'Findings do not retain idle analysis resources');
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
