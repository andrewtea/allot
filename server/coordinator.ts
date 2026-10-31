import { setTimeout } from 'node:timers/promises';
import type { RelaycastMessagingClient, InboxItem } from '@agent-relay/sdk/messaging';
import { actors, type ActorRpcTransport } from './generated/index.js';
import { decodeEvent, studyInputSchema, type StudyInput } from '../study/protocol.ts';
import type { Study } from '../study/state.ts';

export interface SiteConnection {
  siteId: string;
  agentId: string;
  agentName: string;
  relay: RelaycastMessagingClient;
  ensureReady(): Promise<void>;
  readEvidence(artifactId: string): Promise<Uint8Array>;
}

/** No authoritative state lives here: a replacement process reconciles Terse. */
export class Coordinator {
  readonly sites: SiteConnection[];
  readonly transport?: ActorRpcTransport;
  readonly report: (code: string, siteId?: string) => void;

  constructor(sites: SiteConnection[], transport?: ActorRpcTransport,
    report = (code: string, siteId?: string) => console.error(JSON.stringify({ code, siteId }))) {
    if (new Set(sites.map(s => s.siteId)).size !== sites.length) throw new Error('DUPLICATE_SITE');
    this.sites = sites;
    this.transport = transport;
    this.report = report;
  }

  async create(input: StudyInput) {
    const parsed = studyInputSchema.parse(input);
    if (parsed.sites.some(s => !this.sites.some(c => c.siteId === s.site_id))) throw new Error('SITE_NOT_CONFIGURED');
    const result = await actors.StudyActor.get(parsed.study_id, this.transport).initialize(parsed);
    if (result.ok) await actors.DemoRegistryActor.get('demo', this.transport).register(parsed.study_id);
    return result;
  }

  async start(studyId: string, commandId: string, revision: number) {
    const actor = actors.StudyActor.get(studyId, this.transport);
    const study = await actor.work() as Study | null;
    // A replay must return its original outcome without reserving idle sites again.
    if (!study || study.lifecycle !== 'draft') return actor.start(commandId, revision);
    const registry = actors.DemoRegistryActor.get('demo', this.transport);
    const reservation = await registry.reserve(studyId, commandId, revision);
    if (!reservation.ok) return reservation;
    return this.#resumeStart(studyId, commandId, revision);
  }

  async #resumeStart(studyId: string, commandId: string, revision: number) {
    const result = await actors.StudyActor.get(studyId, this.transport).start(commandId, revision);
    if (!result.ok) await actors.DemoRegistryActor.get('demo', this.transport).releaseFailedStart(studyId, commandId, revision);
    return result;
  }

  async cycle() {
    const registryActor = actors.DemoRegistryActor.get('demo', this.transport);
    const registry = await registryActor.work();
    const held = registry.reservation;
    // Crash after reservation but before actor start: complete the same command.
    if (held) await this.#resumeStart(held.study_id, held.command_id, held.revision);
    const study = held ? await actors.StudyActor.get(held.study_id, this.transport).work() as Study | null : null;
    const registered = new Set(registry.studies);
    await Promise.all(this.sites.map(async site => {
      // Dispatch failure must not prevent intake, or another site's progress.
      const run = study?.sites[site.siteId];
      if (run?.state === 'analyzing' && run.deadline > Date.now() &&
          (run.sent_at === null || run.sent_at < Date.now() - 30_000)) {
        try {
          await site.ensureReady();
          await site.relay.messages.direct({ to: site.agentName, text: JSON.stringify(run.request),
            idempotencyKey: run.request.request_id });
          await actors.StudyActor.get(study!.input.study_id, this.transport).markSent(site.siteId, run.request.request_id);
        } catch { this.report('COORDINATOR_DISPATCH_RETRY', site.siteId); }
      }
      try {
        const { items } = await site.relay.inbox.list({ limit: 100 });
        for (const item of items) {
          if (item.availableAt && Date.parse(item.availableAt) > Date.now()) continue;
          try { await this.#receive(site, item, registered); }
          catch {
            this.report('COORDINATOR_DELIVERY_RETRY', site.siteId);
            // Move transient failures out of the first page so later work can drain.
            try { await site.relay.inbox.defer({ inboxItemId: item.id,
              availableAt: new Date(Date.now() + 5000).toISOString(), reason: 'TEMPORARY_PROCESSING_FAILURE' }); }
            catch { /* Leave unacknowledged for the next poll. */ }
          }
        }
      } catch { this.report('COORDINATOR_INBOX_RETRY', site.siteId); }
    }));
    if (held) {
      const current = await actors.StudyActor.get(held.study_id, this.transport).work() as Study | null;
      // Results/evidence are durable before release. Failed or unfinished runs retain
      // the pool for retry; a stale worker cannot release another study's reservation.
      if (current?.lifecycle === 'needs_review' || current?.lifecycle === 'ready_to_finalize') {
        await registryActor.releaseReservation(held.study_id, held.command_id, held.revision);
      }
    }
  }

  async #receive(site: SiteConnection, item: InboxItem, registered: Set<string>) {
    const reject = (error: string) => site.relay.inbox.fail({ inboxItemId: item.id, error, retry: false });
    if (item.message.from.id !== site.agentId) { await reject('UNAUTHORIZED_SENDER'); return; }
    let event;
    try { event = decodeEvent(item.message.text); }
    catch { await reject('INVALID_EVENT'); return; }
    if (event.site_id !== site.siteId || !registered.has(event.study_id)) { await reject('WRONG_DESTINATION'); return; }
    const actor = actors.StudyActor.get(event.study_id, this.transport);
    // First ask the actor: replays and stale attempts require no VM access.
    let result = await actor.accept(event, null);
    if (result === 'EVIDENCE_REQUIRED' && event.type === 'scan_result' && event.payload.result.evidence.status === 'ready') {
      const bytes = await site.readEvidence(event.payload.result.evidence.artifact_id);
      result = await actor.accept(event, Buffer.from(bytes).toString('base64'));
    }
    if (result === 'ACCEPTED' || result === 'DUPLICATE') await site.relay.inbox.ack({ inboxItemId: item.id });
    else await reject(result);
  }

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.cycle(); }
      catch { this.report('COORDINATOR_CYCLE_RETRY'); }
      try { await setTimeout(1000, undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('COORDINATOR_TIMER_FAILED'); }
    }
  }
}
