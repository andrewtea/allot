import { randomUUID } from 'node:crypto';
import { Actor, Persisted, unchecked, type ActorSocket, type Unchecked } from 'terse-sdk/actor';
import { z } from 'zod';
import { eventSchema, studyInputSchema, NO_PROGRESS_MS, type StudyInput } from '../study/protocol.ts';
import { verifyPreview } from '../study/evidence.ts';
import { updateLifecycle, type Outcome, type SiteRun, type Study } from '../study/state.ts';

export class StudyActor extends Actor<{ role: 'viewer' }, { type: 'snapshot' }, { revision: number }> {
  @Persisted private state: Study | null = null;

  async initialize(input: Unchecked<StudyInput>): Promise<Outcome> {
    const parsed = studyInputSchema.parse(input);
    if (parsed.study_id !== this.id) throw new Error('STUDY_ID_MISMATCH');
    if (this.state) return { ok: JSON.stringify(this.state.input) === JSON.stringify(parsed), code: 'EXISTS', revision: this.state.revision };
    await this.#save({ input: parsed, revision: 0, created_at: new Date().toISOString(), lifecycle: 'draft', sites: {}, evidence: {}, seen: {}, commands: {} });
    return { ok: true, code: 'CREATED', revision: 0 };
  }

  /** Backend-only state, including durable jobs. No provider secrets are stored. */
  async work(): Promise<Unchecked<Study | null>> { return unchecked(this.state); }

  async updateTitle(commandId: string, title: string, revision: number): Promise<Outcome> {
    z.uuid().parse(commandId);
    const parsed = studyInputSchema.shape.title.parse(title);
    const state = this.state;
    if (!state) return { ok: false, code: 'NOT_FOUND', revision: 0 };
    const fingerprint = JSON.stringify(['title', parsed, revision]);
    const replay = state.commands[commandId];
    if (replay) return replay.fingerprint === fingerprint ? replay.outcome : { ok: false, code: 'COMMAND_CONFLICT', revision: state.revision };
    if (state.revision !== revision || state.lifecycle !== 'draft') return { ok: false, code: 'CONFLICT', revision: state.revision };
    const next = structuredClone(state);
    next.input.title = parsed;
    next.revision++;
    const outcome = { ok: true, code: 'TITLE_UPDATED', revision: next.revision };
    next.commands[commandId] = { fingerprint, outcome };
    await this.#save(next);
    return outcome;
  }

  async start(commandId: string, revision: number): Promise<Outcome> {
    z.uuid().parse(commandId);
    const state = this.state;
    if (!state) return { ok: false, code: 'NOT_FOUND', revision: 0 };
    const fingerprint = JSON.stringify(['start', revision]);
    const replay = state.commands[commandId];
    if (replay) return replay.fingerprint === fingerprint ? replay.outcome : { ok: false, code: 'COMMAND_CONFLICT', revision: state.revision };
    if (state.revision !== revision || state.lifecycle !== 'draft') return { ok: false, code: 'CONFLICT', revision: state.revision };
    const next = structuredClone(state);
    for (const site of next.input.sites) next.sites[site.site_id] = this.#newRun(next, site.site_id);
    next.revision++;
    const outcome = { ok: true, code: 'STARTED', revision: next.revision };
    next.commands[commandId] = { fingerprint, outcome };
    updateLifecycle(next);
    await this.#save(next);
    return outcome;
  }

  async retrySite(commandId: string, siteId: string, revision: number): Promise<Outcome> {
    z.uuid().parse(commandId);
    const state = this.state;
    if (!state) return { ok: false, code: 'NOT_FOUND', revision: 0 };
    const fingerprint = JSON.stringify(['retry', siteId, revision]);
    const replay = state.commands[commandId];
    if (replay) return replay.fingerprint === fingerprint ? replay.outcome : { ok: false, code: 'COMMAND_CONFLICT', revision: state.revision };
    if (revision !== state.revision || state.sites[siteId]?.state !== 'error') return { ok: false, code: 'CONFLICT', revision: state.revision };
    const next = structuredClone(state);
    const old = next.sites[siteId];
    next.sites[siteId] = this.#newRun(next, siteId);
    // Preserve accepted results for unchanged inputs, but allow a missing preview to recover.
    next.sites[siteId].results = Object.fromEntries(Object.entries(old.results).filter(([, r]) => r.evidence.status !== 'missing'));
    next.revision++;
    const outcome = { ok: true, code: 'RETRYING', revision: next.revision };
    next.commands[commandId] = { fingerprint, outcome };
    updateLifecycle(next);
    await this.#save(next);
    return outcome;
  }

  async markSent(siteId: string, requestId: string): Promise<void> {
    const state = this.state;
    if (!state || state.sites[siteId]?.request.request_id !== requestId) return;
    const next = structuredClone(state);
    next.sites[siteId].sent_at = Date.now();
    await this.#save(next);
  }

  /** Persist valid events before the coordinator ACKs the Relay delivery. */
  async accept(raw: Unchecked<unknown>, preview: string | null): Promise<string> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return 'INVALID_EVENT';
    const event = parsed.data;
    const state = this.state;
    if (!state || event.study_id !== this.id) return 'UNKNOWN_STUDY';
    const run = state.sites[event.site_id];
    if (!run || run.request.request_id !== event.request_id || run.request.attempt_id !== event.attempt_id || run.state === 'error') return 'STALE_ATTEMPT';
    const suffix = event.type === 'scan_result' ? event.payload.result.acquisition_id : event.type === 'site_finished' ? 'finished' : 'error';
    if (event.message_id !== `${event.request_id}:${suffix}`) return 'INVALID_EVENT_ID';
    const fingerprint = JSON.stringify(event);
    const seen = state.seen[event.message_id];
    if (seen) return seen === fingerprint ? 'DUPLICATE' : 'EVENT_CONFLICT';
    if (run.state !== 'analyzing') return 'TERMINAL_ATTEMPT';
    const expected = state.input.sites.find(s => s.site_id === event.site_id)!;
    const next = structuredClone(state);
    const target = next.sites[event.site_id];
    if (event.type === 'scan_result') {
      const result = event.payload.result;
      const acquisition = expected.selected.find(a => a.acquisition_id === result.acquisition_id);
      if (!acquisition || result.site_id !== event.site_id || acquisition.subject_id !== result.subject_id ||
          acquisition.input_sha256 !== result.input_sha256 || acquisition.source_sha256 !== result.provenance.source.sha256) return 'INPUT_MISMATCH';
      if (!target.results[result.acquisition_id]) {
        if (result.evidence.status === 'ready') {
          if (preview === null) return 'EVIDENCE_REQUIRED';
          try { verifyPreview(preview, result.evidence); } catch { return 'INVALID_EVIDENCE'; }
          next.evidence[result.evidence.artifact_id] = preview;
          if (Object.keys(next.evidence).length > 7 || Object.values(next.evidence).reduce((n, b) => n + Buffer.from(b, 'base64').length, 0) > 2 * 1024 * 1024) return 'EVIDENCE_LIMIT';
        }
        target.results[result.acquisition_id] = result;
        target.deadline = Date.now() + NO_PROGRESS_MS;
      }
    } else if (event.type === 'site_finished') {
      if (event.payload.selected_count !== expected.selected.length) return 'COUNT_MISMATCH';
      target.finished = true;
    } else { target.state = 'error'; target.error = event.payload.code; }
    next.seen[event.message_id] = fingerprint;
    next.revision++;
    updateLifecycle(next);
    await this.#save(next);
    return 'ACCEPTED';
  }

  async onAlarm(): Promise<void> {
    if (!this.state) return;
    const next = structuredClone(this.state);
    let changed = false;
    for (const run of Object.values(next.sites)) {
      if (run.state === 'analyzing' && run.deadline <= Date.now()) {
        run.state = 'error'; run.error = 'NO_PROGRESS_TIMEOUT'; changed = true;
      }
    }
    if (changed) next.revision++;
    updateLifecycle(next);
    await this.#save(next);
  }

  async onConnect(socket: ActorSocket<{ role: 'viewer' }, { revision: number }>): Promise<void> {
    if (socket.metadata.role !== 'viewer') { socket.reject(4003, 'READ_ONLY'); return; }
    socket.send({ revision: this.state?.revision ?? 0 });
  }

  async onMessage(socket: ActorSocket<{ role: 'viewer' }, { revision: number }>): Promise<void> {
    // Grants are read-only even if a viewer sends a forged write message.
    socket.close(4003, 'READ_ONLY');
  }

  #newRun(state: Study, siteId: string): SiteRun {
    const requestId = randomUUID();
    return { site_id: siteId, state: 'analyzing', deadline: Date.now() + NO_PROGRESS_MS, sent_at: null,
      finished: false, results: {}, error: null, request: {
        schema_version: 1, type: 'analyze_site', message_id: requestId, request_id: requestId,
        study_id: this.id, site_id: siteId, attempt_id: randomUUID(),
        payload: { workflow_version: 'mri-integrity-v1', manifest_sha256: state.input.sites.find(s => s.site_id === siteId)!.manifest_sha256 },
      } };
  }

  async #save(next: Study) {
    await this.db.transaction(async () => {
      this.state = next;
      const deadlines = Object.values(next.sites).filter(s => s.state === 'analyzing').map(s => s.deadline);
      if (deadlines.length) this.alarm.set(Math.min(...deadlines)); else this.alarm.delete();
    });
    this.broadcast({ revision: next.revision });
  }
}

type Reservation = { study_id: string; command_id: string; revision: number };
type Registry = { studies: string[]; reservation: Reservation | null };

export class DemoRegistryActor extends Actor {
  @Persisted private state: Registry = { studies: [], reservation: null };

  async register(studyId: string): Promise<void> {
    z.uuid().parse(studyId);
    if (!this.state.studies.includes(studyId)) {
      this.state = { ...this.state, studies: [...this.state.studies, studyId] };
    }
  }

  async work(): Promise<Registry> { return this.state; }

  async reserve(studyId: string, commandId: string, revision: number): Promise<Outcome> {
    z.uuid().parse(commandId);
    if (!this.state.studies.includes(studyId)) return { ok: false, code: 'NOT_FOUND', revision: 0 };
    const held = this.state.reservation;
    if (held && (held.study_id !== studyId || held.command_id !== commandId || held.revision !== revision)) return { ok: false, code: 'POOL_BUSY', revision: 0 };
    // The coordinator resumes this durable intent before dispatching any work.
    this.state = { ...this.state, reservation: { study_id: studyId, command_id: commandId, revision } };
    return { ok: true, code: 'RESERVED', revision };
  }

  async releaseFailedStart(studyId: string, commandId: string, revision: number): Promise<void> {
    // Keep the previous RPC available during rolling application deployments.
    await this.releaseReservation(studyId, commandId, revision);
  }

  async releaseReservation(studyId: string, commandId: string, revision: number): Promise<void> {
    const held = this.state.reservation;
    if (held?.study_id === studyId && held.command_id === commandId && held.revision === revision) {
      this.state = { ...this.state, reservation: null };
    }
  }
}
