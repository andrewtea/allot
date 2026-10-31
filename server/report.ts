import { inclusion, type Study } from '../study/state.ts';

export function reportSnapshot(study: Study) {
  if (study.lifecycle !== 'finalized') throw new Error('NOT_FINALIZED');
  const subjects = inclusion(study);
  const counts = (rows: typeof subjects) => ({ selected: rows.length,
    included: rows.filter(r => r.status === 'included' || r.status === 'replaced').length,
    excluded: rows.filter(r => r.status === 'excluded').length, replaced: rows.filter(r => r.status === 'replaced').length });
  return { schema_version: 'allot-report-v1', study_id: study.input.study_id, title: study.input.title,
    created_at: study.created_at, finalized_at: study.finalized_at, revision: study.revision,
    workflow: 'mri-integrity-v1', counts: counts(subjects),
    sites: study.input.sites.map(site => ({ site_id: site.site_id, manifest_sha256: site.manifest_sha256,
      counts: counts(subjects.filter(s => s.site_id === site.site_id)) })), subjects,
    originals: Object.values(study.sites).flatMap(s => Object.values(s.results)),
    investigations: Object.entries(study.investigations ?? {}).map(([finding_id, j]) => ({ finding_id, proposal: j.proposal })),
    decisions: study.decisions ?? {},
    evidence: Object.fromEntries(Object.entries(study.evidence).map(([id, bytes]) => [id, `data:image/png;base64,${bytes}`])),
    limitations: 'Simulated sites · Public research data · Not for clinical use. Synthetic blank-slab and zero-signal corruptions are labeled in provenance. Foreground is a descriptive signal proxy, not brain volume. Blank-slab checks are heuristic; all detected intervals are retained. No clinical suitability, disease inference or statistical effect is established.',
  };
}

export function markdownReport(study: Study) {
  const report = reportSnapshot(study);
  const safe = (text: string) => text.replace(/[<>&|\[\]\\`*_#]/g, c => `&#${c.charCodeAt(0)};`).replaceAll('\n', ' ');
  const lines = [`# ${safe(report.title)}`, '', `Finalized: ${report.finalized_at} · Workflow: ${report.workflow}`, '',
    `${report.counts.selected} selected · ${report.counts.included} included · ${report.counts.excluded} excluded · ${report.counts.replaced} replacement(s)`, '',
    report.limitations, '', '| Site | Selected | Included | Excluded | Replaced |', '| --- | ---: | ---: | ---: | ---: |',
    ...report.sites.map(s => `| ${s.site_id} | ${s.counts.selected} | ${s.counts.included} | ${s.counts.excluded} | ${s.counts.replaced} |`), '',
    '## Human decisions', ...Object.entries(report.decisions).map(([key, d]) => `- ${key}: ${d.action}${d.candidate_id ? ` → ${d.candidate_id}` : ''}. ${safe(d.reason)} (${d.researcher}, ${d.at})`), '',
    '## Subject inclusion', ...report.subjects.map(s => `- ${s.site_id} / ${s.subject_id}: ${s.status}; ${s.acquisition_id ?? 'none'}`)];
  const results = [...report.originals, ...report.investigations.flatMap(j => j.proposal?.candidate ? [j.proposal.candidate] : [])];
  for (const r of results) {
    lines.push('', `## ${r.site_id} / ${r.acquisition_id}`, '', r.checks_passed ? 'Checks passed' : `Failed checks: ${r.findings.map(f => f.code).join(', ')}`,
      '', '```json', JSON.stringify({ measurements: r.measurements, findings: r.findings, input_sha256: r.input_sha256, provenance: r.provenance }, null, 2), '```');
    if (r.evidence.status === 'ready') lines.push('', `![Derived montage ${r.acquisition_id}](${report.evidence[r.evidence.artifact_id]})`);
    else lines.push(`Evidence: ${r.evidence.error}`);
  }
  return lines.join('\n');
}
