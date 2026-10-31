import type { AnalysisRequest, ScanResult, StudyInput } from './protocol.ts';

export type Outcome = { ok: boolean; code: string; revision: number };
export type SiteRun = {
  site_id: string; state: 'analyzing' | 'complete' | 'needs_review' | 'error';
  request: AnalysisRequest; deadline: number; sent_at: number | null; finished: boolean;
  results: Record<string, ScanResult>; error: string | null;
};
export type Study = {
  input: StudyInput; revision: number; created_at: string;
  lifecycle: 'draft' | 'running' | 'blocked' | 'needs_review' | 'ready_to_finalize';
  sites: Record<string, SiteRun>; evidence: Record<string, string>;
  seen: Record<string, string>;
  commands: Record<string, { fingerprint: string; outcome: Outcome }>;
};

export function updateLifecycle(study: Study) {
  const runs = Object.values(study.sites);
  if (!runs.length) return;
  for (const run of runs) {
    if (run.state === 'error') continue;
    const expected = study.input.sites.find(s => s.site_id === run.site_id)!;
    const results = Object.values(run.results);
    if (run.finished && expected.selected.every(a => run.results[a.acquisition_id])) {
      if (results.some(r => r.evidence.status === 'missing')) {
        run.state = 'error'; run.error = 'PREVIEW_MISSING';
      } else run.state = results.some(r => !r.checks_passed) ? 'needs_review' : 'complete';
    }
  }
  study.lifecycle = runs.some(r => r.state === 'error') ? 'blocked'
    : runs.some(r => r.state === 'analyzing') ? 'running'
    : runs.some(r => r.state === 'needs_review') ? 'needs_review' : 'ready_to_finalize';
}
