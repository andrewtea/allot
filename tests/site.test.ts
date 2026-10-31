import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RelaycastMessagingClient, type InboxItem } from '@agent-relay/sdk/messaging';
import { SiteRunner } from '../site/runner.ts';

test('durable intake and outbox recover across restart without rerunning completed work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allot-site-'));
  const python = resolve('.venv/bin/python');
  let runner: SiteRunner | undefined;
  try {
    execFileSync(python, ['-c', `
import nibabel as nib, numpy as np, sys
data = np.zeros((12, 16, 18), dtype=np.float32)
data[2:10, 3:13, 4:16] = 100
nib.save(nib.Nifti1Image(data, np.diag([2, 3, 4, 1])), sys.argv[1])
`, join(root, 'scan.nii')]);
    const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const inputHash = digest(await readFile(join(root, 'scan.nii')));
    const manifest = JSON.stringify({ site_id: 'site-b', acquisitions: [{
      acquisition_id: 'scan', subject_id: 'subject', role: 'selected', path: 'scan.nii',
      sha256: inputHash, source: { name: 'Synthetic regression volume' },
    }] });
    await writeFile(join(root, 'manifest.json'), manifest);
    const request = { schema_version: 1, type: 'analyze_site', message_id: randomUUID(),
      request_id: randomUUID(), study_id: randomUUID(), site_id: 'site-b', attempt_id: randomUUID(),
      payload: { workflow_version: 'mri-integrity-v1', manifest_sha256: digest(manifest) } };
    let inbox: InboxItem[] = [];
    const enqueue = (body: unknown, sender = 'coordinator') => inbox.push({
      id: randomUUID(), recipient: { name: 'site-b' }, state: 'queued', attempts: 0,
      message: { id: randomUUID(), messageId: randomUUID(), text: JSON.stringify(body), from: { id: sender } },
    });
    const relay = new RelaycastMessagingClient({ agentToken: 'test-only', baseUrl: 'https://example.invalid' });
    relay.inbox.list = async ({ limit = 100 } = {}) => ({ items: inbox.slice(0, limit) });
    const acknowledge: typeof relay.inbox.ack = async ({ inboxItemId }) => {
      inbox = inbox.filter(item => item.id !== inboxItemId);
      return { supported: true, action: 'ack', deliveryId: inboxItemId, messageId: inboxItemId, state: 'read' };
    };
    relay.inbox.ack = async () => { throw new Error('Connection lost before ACK'); };
    const events = new Map<string, any>();
    let loseSendConfirmation = true;
    relay.messages.direct = async input => {
      events.set(input.idempotencyKey!, JSON.parse(input.text));
      if (loseSendConfirmation) throw new Error('Connection lost after send');
      return { id: input.idempotencyKey!, messageId: input.idempotencyKey!, text: input.text, from: { id: 'site-b' } };
    };
    const config = { siteId: 'site-b', coordinatorId: 'coordinator', coordinatorName: 'coordinator',
      datasetRoot: root, evidenceDir: join(root, 'evidence'), projectRoot: resolve('.'), python,
      database: join(root, 'jobs.sqlite') };
    enqueue(request);
    runner = new SiteRunner(config, relay);
    await assert.rejects(runner.cycle(), /before ACK/);
    assert.equal(inbox.length, 1);
    assert.equal(events.size, 0);
    runner.close();
    runner = new SiteRunner(config, relay);
    relay.inbox.ack = acknowledge;
    await assert.rejects(runner.cycle(), /after send/);
    const first = [...events.values()][0];
    assert.equal(first.payload.result.checks_passed, true);
    assert.equal(first.payload.result.input_sha256, inputHash);
    const evidence = first.payload.result.evidence;
    assert.equal(digest(await readFile(join(root, 'evidence', `${evidence.artifact_id}.png`))), evidence.sha256);
    // A rerun would now fail input validation. Recovery must use the durable result.
    await writeFile(join(root, 'scan.nii'), 'changed input');
    runner.close();
    runner = new SiteRunner(config, relay);
    loseSendConfirmation = false;
    await runner.cycle();
    assert.equal(events.size, 2);
    assert.deepEqual(events.get(first.message_id), first);
    assert.equal([...events.values()].find(e => e.type === 'site_finished').payload.selected_count, 1);

    events.clear();
    enqueue({ ...request, message_id: randomUUID() });
    enqueue({ ...request, message_id: randomUUID(), attempt_id: randomUUID() });
    enqueue({ ...request, request_id: randomUUID() }, 'impostor');
    enqueue({ ...request, request_id: randomUUID(), site_id: 'site-a' });
    enqueue({ ...request, request_id: randomUUID(), payload: { ...request.payload, manifest_sha256: '0'.repeat(64) } });
    // More than one queue page, including malformed and oversized envelopes.
    for (let i = 0; i < 205; i++) enqueue({ command: i === 0 ? 'x'.repeat(17000) : 'forbidden' });
    for (let i = 0; i < 3; i++) await runner.cycle();
    assert.equal(inbox.length, 0);
    assert.equal(events.size, 0, 'Duplicates and invalid commands must not execute');
    enqueue({ ...request, request_id: randomUUID() });
    await runner.cycle();
    assert.equal(events.size, 1);
    const failure = [...events.values()][0];
    assert.equal(failure.type, 'job_error');
    assert.deepEqual(failure.payload, { code: 'SITE_ANALYSIS_FAILED' });
    assert(!JSON.stringify(failure).includes(root));
  } finally {
    runner?.close();
    await rm(root, { recursive: true, force: true });
  }
});
