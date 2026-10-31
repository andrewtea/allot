import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';
import { investigationRequestSchema, requestSchema as analysisRequestSchema, type ScanResult } from '../study/protocol.ts';
import { investigate } from './investigation.ts';

const exec = promisify(execFile);
const requestSchema = z.union([analysisRequestSchema, investigationRequestSchema]);
type Request = z.infer<typeof requestSchema>;

export interface SiteConfig {
  siteId: string;
  coordinatorId: string;
  coordinatorName: string;
  datasetRoot: string;
  evidenceDir: string;
  projectRoot: string;
  python: string;
  database: string;
  model?: string;
  modelApiKey?: string;
}

/** One supervised consumer per site. SQLite owns intake and the result outbox. */
export class SiteRunner {
  readonly db: DatabaseSync;
  readonly config: SiteConfig;
  readonly relay: RelaycastMessagingClient;

  constructor(config: SiteConfig, relay: RelaycastMessagingClient) {
    this.config = config;
    this.relay = relay;
    this.db = new DatabaseSync(config.database);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        request_id TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        request TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        executions INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rejections (
        delivery_id TEXT PRIMARY KEY,
        code TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  async cycle() {
    const inbox = await this.relay.inbox.list({ limit: 100 });
    for (const item of inbox.items) {
      if (item.availableAt && Date.parse(item.availableAt) > Date.now()) continue;
      let rejection: string | undefined;
      let request: Request | undefined;
      if (item.message.from.id !== this.config.coordinatorId) {
        rejection = 'UNAUTHORIZED_SENDER';
      } else if (Buffer.byteLength(item.message.text, 'utf8') > 16384) {
        rejection = 'OVERSIZED_REQUEST';
      } else {
        try {
          request = requestSchema.parse(JSON.parse(item.message.text));
        } catch { rejection = 'INVALID_REQUEST'; }
      }
      if (request) {
        if (request.site_id !== this.config.siteId) rejection = 'WRONG_SITE';
        else if (request.payload.manifest_sha256 !== this.manifestHash()) rejection = 'INPUT_SNAPSHOT_MISMATCH';
        else {
          // A resent logical command may have a new transport message ID.
          const { message_id: _messageId, ...identity } = request;
          const fingerprint = JSON.stringify(identity);
          const existing = this.db.prepare('SELECT identity FROM jobs WHERE request_id=?').get(request.request_id);
          if (existing && existing.identity !== fingerprint) rejection = 'REQUEST_ID_CONFLICT';
          else {
            this.db.prepare('INSERT OR IGNORE INTO jobs(request_id,identity,request) VALUES(?,?,?)')
              .run(request.request_id, fingerprint, JSON.stringify(request));
          }
        }
      }
      if (rejection) {
        this.db.prepare('INSERT OR IGNORE INTO rejections(delivery_id,code) VALUES(?,?)').run(item.id, rejection);
      }
      // Both accepted jobs and rejected deliveries are durable before ACK.
      await this.relay.inbox.ack({ inboxItemId: item.id });
    }

    const pending = this.db.prepare("SELECT request FROM jobs WHERE state='pending' ORDER BY rowid").all();
    for (const row of pending) {
      const request = requestSchema.parse(JSON.parse(String(row.request)));
      this.db.prepare('UPDATE jobs SET executions=executions+1 WHERE request_id=?').run(request.request_id);
      let messages: unknown[];
      try {
        if (request.payload.manifest_sha256 !== this.manifestHash()) throw new Error('INPUT_SNAPSHOT_MISMATCH');
        if (request.type === 'investigate_finding') {
          const proposal = await investigate({ original: request.payload.original,
            manifest: JSON.parse(readFileSync(join(this.config.datasetRoot, 'manifest.json'), 'utf8')),
            evidenceDir: this.config.evidenceDir, analyze: (id, timeout) => this.analyzeScan(id, timeout),
            apiKey: this.config.modelApiKey ?? 'edge-injected', model: this.config.model ?? 'gpt-4.1-mini' });
          messages = [this.response(request, 'finding_proposal', { proposal }, 'proposal')];
        } else messages = await this.analyze(request);
      } catch {
        // Never forward tool exceptions, stderr, paths, or credentials.
        messages = [this.response(request, 'job_error', { code: 'SITE_ANALYSIS_FAILED' }, 'error')];
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const body of messages) {
          const event = body as { message_id: string };
          this.db.prepare('INSERT INTO outbox(event_id,body) VALUES(?,?)').run(event.message_id, JSON.stringify(body));
        }
        this.db.prepare("UPDATE jobs SET state='complete' WHERE request_id=?").run(request.request_id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    for (const row of this.db.prepare('SELECT event_id,body FROM outbox WHERE sent=0 ORDER BY rowid').all()) {
      await this.relay.messages.direct({
        to: this.config.coordinatorName,
        text: String(row.body),
        idempotencyKey: String(row.event_id),
      });
      this.db.prepare('UPDATE outbox SET sent=1 WHERE event_id=?').run(row.event_id);
    }
  }

  private manifestHash() {
    return createHash('sha256').update(readFileSync(join(this.config.datasetRoot, 'manifest.json'))).digest('hex');
  }

  private response(request: Request, type: string, payload: unknown, suffix: string) {
    return {
      schema_version: 1,
      type,
      message_id: `${request.request_id}:${suffix}`,
      request_id: request.request_id,
      study_id: request.study_id,
      site_id: request.site_id,
      attempt_id: request.attempt_id,
      payload,
    };
  }

  private async analyze(request: Request) {
    if (request.payload.manifest_sha256 !== this.manifestHash()) throw new Error('INPUT_SNAPSHOT_MISMATCH');
    const manifest = JSON.parse(readFileSync(join(this.config.datasetRoot, 'manifest.json'), 'utf8'));
    if (manifest.site_id !== this.config.siteId) throw new Error('WRONG_SITE');
    const selected = manifest.acquisitions.filter((item: { role: string }) => item.role === 'selected');
    if (!selected.length) throw new Error('EMPTY_SITE');
    const messages: unknown[] = [];
    for (const acquisition of selected) {
      const started = performance.now();
      const result = await this.analyzeScan(acquisition.acquisition_id);
      if (result.input_sha256 !== acquisition.sha256 || result.acquisition_id !== acquisition.acquisition_id) {
        throw new Error('RESULT_IDENTITY_MISMATCH');
      }
      messages.push(this.response(request, 'scan_result', { result, elapsed_ms: Math.round(performance.now() - started) }, acquisition.acquisition_id));
    }
    messages.push(this.response(request, 'site_finished', { selected_count: selected.length }, 'finished'));
    return messages;
  }

  private async analyzeScan(acquisitionId: string, timeout = 120_000): Promise<ScanResult> {
    const { stdout } = await exec(this.config.python, ['-m', 'analysis.integrity',
      '--dataset-root', this.config.datasetRoot, '--manifest', join(this.config.datasetRoot, 'manifest.json'),
      '--acquisition-id', acquisitionId, '--evidence-dir', this.config.evidenceDir,
    ], { cwd: this.config.projectRoot, timeout, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
  }
}
