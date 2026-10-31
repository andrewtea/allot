import type { AnalysisRequest, InvestigationRequest, Proposal, ScanResult, StudyInput } from './protocol.ts';

export type Outcome = { ok: boolean; code: string; revision: number };
export type SiteRun = {
  site_id: string; state: 'analyzing' | 'complete' | 'needs_review' | 'error';
  request: AnalysisRequest; deadline: number; sent_at: number | null; finished: boolean;
  results: Record<string, ScanResult>; error: string | null;
};
export type Study = {
  input: StudyInput; revision: number; created_at: string;
  lifecycle: 'draft' | 'running' | 'blocked' | 'needs_review' | 'ready_to_finalize' | 'finalized';
  investigations?: Record<string, { request: InvestigationRequest; state: 'investigating' | 'complete' | 'error';
    deadline: number; sent_at: number | null; proposal?: Proposal; error?: string }>;
  decisions?: Record<string, { action: 'replace' | 'exclude'; reason: string; candidate_id: string | null; at: string; researcher: string }>;
  finalized_at?: string;
  adaptive?: boolean;
  sites: Record<string, SiteRun>; evidence: Record<string, string>;
  seen: Record<string, string>;
  commands: Record<string, { fingerprint: string; outcome: Outcome }>;
};

export function updateLifecycle(study: Study) {
  if (study.lifecycle === 'finalized') return;
  const runs = Object.values(study.sites);
  if (!runs.length) return;
  for (const run of runs) {
    if (run.state === 'error') continue;
    const expected = study.input.sites.find(s => s.site_id === run.site_id)!;
    const results = Object.values(run.results);
    if (run.finished && expected.selected.every(a => run.results[a.acquisition_id])) {
      if (results.some(r => r.evidence.status === 'missing')) {
        run.state = 'error'; run.error = 'PREVIEW_MISSING';
      } else run.state = results.some(r => !r.checks_passed && !study.decisions?.[`${run.site_id}:${r.acquisition_id}`]) ? 'needs_review' : 'complete';
    }
  }
  study.lifecycle = runs.some(r => r.state === 'error') || Object.values(study.investigations ?? {}).some(j => j.state === 'error') ? 'blocked'
    : runs.some(r => r.state === 'analyzing') || Object.values(study.investigations ?? {}).some(j => j.state === 'investigating') ? 'running'
    : runs.some(r => r.state === 'needs_review') ? 'needs_review' : 'ready_to_finalize';
}

export function inclusion(study: Study) {
  return study.input.sites.flatMap(site => site.selected.map(selected => {
    const key = `${site.site_id}:${selected.acquisition_id}`;
    const original = study.sites[site.site_id]?.results[selected.acquisition_id];
    const decision = study.decisions?.[key];
    const replacement = study.investigations?.[key]?.proposal?.candidate;
    return { site_id: site.site_id, subject_id: selected.subject_id, original_id: selected.acquisition_id,
      status: decision?.action === 'exclude' ? 'excluded' : decision?.action === 'replace' ? 'replaced' : original?.checks_passed ? 'included' : 'unresolved',
      acquisition_id: decision?.action === 'replace' ? replacement!.acquisition_id : original?.checks_passed ? original.acquisition_id : null };
  }));
}
