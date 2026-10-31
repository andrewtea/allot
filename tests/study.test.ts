import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalActors } from 'terse-sdk/dev';
import { actors, createActorTransport } from '../server/generated/index.js';
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
