import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { StudyView } from '../../server/studies.ts';
import type { ScanResult } from '../../study/protocol.ts';
import './style.css';

type Session = { mode: 'local' | 'managed' | 'unconfigured'; sites: { id: string; selected: number }[] };
type Operation = { path: string; body: object };
const studyId = /^\/studies\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1];
const messages: Record<string, string> = {
  INVALID_CREDENTIAL: 'That demo credential was not recognized. Try again.',
  SIGN_IN_REQUIRED: 'Sign in to open this study.',
  TRY_LATER: 'Too many sign-in attempts. Wait a minute and try again.',
  POOL_BUSY: 'Another study is analyzing or needs a site retry. This study is still a draft. Try Run analysis again after that study finishes.',
  CONFLICT: 'This study changed in another tab. The current state has been refreshed; review it before trying again.',
  COMMAND_CONFLICT: 'This command conflicts with an earlier request. Reload the study before continuing.',
  NOT_FOUND: 'This study or evidence was not found. Check the study URL.',
  SERVICE_UNAVAILABLE: 'The study service is unavailable. Your last known state is shown.',
  CLOUD_NOT_CONFIGURED: 'Cloud study services are not connected. No analysis has been started.',
  INVALID_REQUEST: 'Check the title and try again.',
  ORIGIN_REJECTED: 'This address is not configured for writes. Ask the operator to configure the public app origin.',
  SITE_ANALYSIS_FAILED: 'The site could not complete its analysis. Restore the site or tool, then retry. Completed sites remain intact.',
  NO_PROGRESS_TIMEOUT: 'No analysis progress for five minutes. Check the site connection, then retry.',
  PREVIEW_MISSING: 'A derived preview could not be generated. Preview-only recovery is not implemented in this phase. Retrying this site reruns its analysis.',
};
class ApiError extends Error {
  status: number;
  constructor(status: number, code: string) { super(messages[code] ?? 'The request failed. Please try again.'); this.status = status; }
}
async function api<T>(path: string, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error ?? data.code);
  return data;
}
const siteName = (id: string) => `Site ${id.slice(-1).toUpperCase()}`;
const date = (value: string | number) => new Date(value).toLocaleString();
const labels: Record<string, string> = { draft: 'Draft', running: 'Running', blocked: 'Blocked', needs_review: 'Needs review',
  ready_to_finalize: 'Ready to finalize', finalized: 'Finalized report', investigating: 'Investigating', analyzing: 'Analyzing', complete: 'Complete', queued: 'Not started', error: 'Error' };
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{labels[value] ?? value}</span>; }

function App() {
  const [session, setSession] = useState<Session | null>();
  const [study, setStudy] = useState<StudyView>();
  const [error, setError] = useState('');
  const [stale, setStale] = useState(true);
  const [updated, setUpdated] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Operation>();
  const lock = useRef(false);
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedScan, setSelectedScan] = useState('');
  const [detail, setDetail] = useState(false);
  const detailPane = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [credential, setCredential] = useState('');
  const createId = useRef(sessionStorage.getItem('allot-create-id') ?? crypto.randomUUID());

  useEffect(() => {
    if (detail && matchMedia('(max-width: 760px)').matches) detailPane.current?.focus();
  }, [detail]);

  async function refresh() {
    if (!studyId) return;
    try {
      const data = await api<StudyView>(`/api/studies/${studyId}`);
      setStudy(old => !old || data.revision >= old.revision ? data : old);
      setUpdated(Date.now()); setStale(false);
    } catch (e) {
      setStale(true);
      if (e instanceof ApiError && e.status === 401) { setSession(null); setStudy(undefined); }
      if (e instanceof ApiError && e.status === 404) setError(e.message);
    }
  }
  useEffect(() => { api<Session>('/api/session').then(setSession).catch(e => {
    setSession(null); if (!(e instanceof ApiError && e.status === 401)) setError('Cannot reach the application. Try signing in again.');
  }); }, []);
  useEffect(() => {
    if (!session || session.mode === 'unconfigured' || !studyId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await refresh(); if (!stopped) timer = setTimeout(tick, 2000); };
    void tick();
    const offline = () => setStale(true);
    addEventListener('offline', offline);
    return () => { stopped = true; clearTimeout(timer); removeEventListener('offline', offline); };
  }, [session]);

  async function execute(operation: Operation) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setPending(operation);
    try {
      const result = await api<{ id?: string }>(operation.path, operation.body);
      setPending(undefined);
      if (operation.path === '/api/studies') {
        sessionStorage.removeItem('allot-create-id');
        location.assign(`/studies/${result.id}`);
      } else { setEditing(false); await refresh(); }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connection interrupted. Retry the same request to safely confirm its outcome.');
      if (e instanceof ApiError && e.status < 500) setPending(undefined);
      if (e instanceof ApiError && e.status === 401) { setSession(null); setStudy(undefined); }
      else await refresh();
    } finally { lock.current = false; setBusy(false); }
  }
  const command = (action: string, extra = {}) => execute({ path: `/api/studies/${studyId}/${action}`,
    body: { commandId: crypto.randomUUID(), revision: study!.revision, ...extra } });
  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/session', { credential }); setCredential(''); setSession(await api<Session>('/api/session')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }
  async function signOut() {
    try { await api('/api/session', undefined, 'DELETE'); setStudy(undefined); setSession(null); setPending(undefined); }
    catch { setError('Could not sign out. Check the connection and try again.'); }
  }
  const site = study?.sites.find(s => s.id === selectedSite) ?? study?.sites[0];
  const scan = site?.results.find(r => r.acquisition_id === selectedScan) ?? site?.results[0];
  const all = study?.sites.flatMap(s => s.results) ?? [];
  const disabled = busy || !!pending || stale;
  return <>
    <header className="masthead"><a className="brand" href="/" aria-label="Allot home">allot</a><span>Research workspace</span>
      {session && <nav>{session.mode !== 'unconfigured' && <a href="/">New study</a>}<button className="text-button" onClick={signOut}>Sign out</button></nav>}</header>
    <main>
      {session?.mode === 'local' && <p className="environment">Local development · Real Python / SQLite / Terse · In-memory messaging, not cloud end-to-end</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {pending && !busy && <button onClick={() => execute(pending)}>Retry same request</button>}
      {session === undefined ? <p role="status">Opening workspace…</p> : !session ?
        <section className="start"><p className="eyebrow">Demo researcher access</p><h1>Inspect the evidence.<br />Keep the data local.</h1>
          <p>Run fixed image-integrity checks across three simulated research sites. Only measurements, provenance, and permitted derived previews enter the study.</p>
          <form onSubmit={signIn}><label htmlFor="credential">Demo credential</label><input id="credential" type="password" autoComplete="current-password" required value={credential} onChange={e => setCredential(e.target.value)} />
            <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form>
          <p className="muted">Use the credential supplied privately by your operator. This is demo access, not production identity management.</p></section>
        : session.mode === 'unconfigured' ? <section className="start"><p className="eyebrow">Deployment status</p><h1>Cloud setup pending</h1>
          <p>The browser workspace is deployed and researcher sign-in is working. Cloud study services are not connected yet.</p>
          <p className="notice">Creating studies, running analysis, and retrieving results are unavailable. No analysis is running here, and no local or simulated results are presented as cloud execution.</p>
          <h2>Required before the first cloud study</h2><ul>
            <li>Deploy the managed Terse study actors.</li><li>Connect the three Freestyle sites through authenticated Relay messaging.</li>
            <li>Configure the immutable dataset snapshot and verify evidence retrieval.</li><li>Resolve always-running coordination: free Render can sleep when idle.</li>
          </ul><p className="muted">Investigation, human approvals, and final reports remain a later phase.</p></section>
        : !studyId ? <section className="start"><p className="eyebrow">New study</p><h1>MRI integrity review</h1>
          <p>{session.sites.reduce((n, s) => n + s.selected, 0)} public T1-weighted acquisitions. One fixed workflow. Inspect what passed, what needs review, and the image evidence behind each result.</p>
          <TitleForm label="Study title" initial="MRI integrity review" submit="Create study" disabled={busy || !!pending} onSubmit={title => {
            sessionStorage.setItem('allot-create-id', createId.current);
            void execute({ path: '/api/studies', body: { id: createId.current, title } });
          }} />
          <h2>Preconfigured sites</h2><ul className="setup-sites">{session.sites.map(s => <li key={s.id}><span>{siteName(s.id)}</span><span>{s.selected} selected scans</span></li>)}</ul>
          <p className="muted">Workflow: MRI integrity review v1. All sites are required. Raw MRI volumes and local file paths are not shared. Sites B and C contain labeled synthetic corruptions.</p>
          <p className="notice">Flagged scans receive bounded agent investigation. Only your approval can replace or exclude a subject. Finalized reports retain original evidence. Viewer sharing is not available yet.</p>
          <Reopen /></section>
        : !study ? <section className="start"><h1>Opening study</h1><p>Fetching the persisted study snapshot.</p><button onClick={refresh}>Try again</button></section>
        : <>
          <section className="study-header"><div className="title-line"><h1>{study.title}</h1><Status value={study.lifecycle} /></div>
            <p className="muted">MRI integrity review v1 · {study.sites.length} simulated sites</p>
            <p className="counts"><span><strong>{study.inclusion.length}</strong> selected</span><span><strong>{study.inclusion.filter(i => i.status === 'included' || i.status === 'replaced').length}</strong> included{study.lifecycle !== 'finalized' && ' (provisional)'}</span><span><strong>{study.inclusion.filter(i => i.status === 'excluded').length}</strong> excluded</span><span><strong>{study.inclusion.filter(i => i.status === 'replaced').length}</strong> replacement</span><span><strong>{study.inclusion.filter(i => i.status === 'unresolved').length}</strong> unresolved</span></p>
            <div className="toolbar"><span className={stale ? 'connection stale' : 'connection'} role="status">{stale ? 'Disconnected · showing last known state' : 'Connected · refreshes every 2 seconds'}{updated && ` · ${date(updated)}`}</span>
              {study.lifecycle === 'draft' && <><button disabled={disabled} onClick={() => command('start')}>{busy ? 'Submitting…' : 'Run analysis'}</button><button className="secondary" disabled={disabled} onClick={() => setEditing(!editing)}>Edit title</button></>}
              {study.lifecycle === 'needs_review' && all.some(r => !r.checks_passed && !study.investigations[`${r.site_id}:${r.acquisition_id}`]) && <button disabled={disabled} onClick={() => command('investigate')}>Investigate findings</button>}
              {Object.values(study.investigations).some(j => j.state === 'error') && <button disabled={disabled} onClick={() => command('investigate')}>Retry investigation</button>}
              {study.lifecycle !== 'draft' && study.lifecycle !== 'finalized' && <button disabled={disabled || study.lifecycle !== 'ready_to_finalize' || !study.inclusion.some(i => i.status === 'included' || i.status === 'replaced')} onClick={() => command('finalize')}>Finalize report</button>}
              {study.lifecycle === 'finalized' && <><a href={`/api/studies/${study.id}/export.md`}>Download Markdown</a><a href={`/api/studies/${study.id}/export.json`}>Download JSON</a></>}
            </div>
            {editing && <TitleForm initial={study.title} label="Study title" submit="Save title" disabled={disabled} onSubmit={title => command('title', { title })} />}
            <p className="phase-note">{study.lifecycle === 'finalized' ? `Frozen ${date(study.finalized_at!)}. Original scans, proposals, human decisions and previews are retained.` : 'Agent suggestions do not change inclusion. Resolve every finding before finalizing; leave unresolved by making no decision.'} Passing checks does not establish clinical or scientific suitability.</p>
          </section>
          <div className={`workspace ${detail ? 'show-detail' : ''}`}>
            <aside className="sites"><h2>Sites</h2><p className="muted small">Select a site, then an acquisition.</p>
              {study.sites.map(s => <div key={s.id}><button className="site-row" aria-pressed={site?.id === s.id} onClick={() => { setSelectedSite(s.id); setSelectedScan(''); }}>
                <span>{siteName(s.id)}</span><Status value={s.state} /><small>{s.results.length} / {s.selected.length} measured</small></button>
                {site?.id === s.id && <ul className="scans">{s.selected.map(a => {
                  const r = s.results.find(r => r.acquisition_id === a.acquisition_id);
                  return <li key={a.acquisition_id}><button disabled={!r} aria-pressed={scan?.acquisition_id === a.acquisition_id} onClick={() => { setSelectedScan(a.acquisition_id); setDetail(true); }}>
                    <span>{a.acquisition_id}</span><small>{r ? r.checks_passed ? '✓ Checks passed' : '! Flagged' : 'Awaiting analysis'}</small></button></li>;
                })}</ul>}
              </div>)}
              {site?.state === 'error' && <div className="site-error"><h3>Site error</h3><p>{messages[site.error!] ?? 'Analysis could not finish.'}</p>
                <button disabled={disabled} onClick={() => command(`sites/${site.id}/retry`)}>Retry site</button><p className="small">Only {siteName(site.id)} restarts. Accepted results at other sites stay unchanged.</p></div>}
              <p className="muted small">Closing this tab does not stop the worker. Save this study URL to reopen it.</p>
            </aside>
            <section ref={detailPane} tabIndex={-1} className="scan-detail" aria-label="Acquisition detail"><button className="back secondary" onClick={() => setDetail(false)}>← Back to sites</button>
              {scan ? <><Review key={`review:${site!.id}:${scan.acquisition_id}`} study={study} result={scan} disabled={disabled} decide={(extra) => command('decide', extra)} /><Scan key={`${site!.id}:${scan.acquisition_id}`} study={study} result={scan} /></> : <><p className="eyebrow">{site && siteName(site.id)}</p><h2>{study.lifecycle === 'draft' ? 'Ready when you are' : site?.state === 'error' ? 'Analysis interrupted' : 'Waiting for measurements'}</h2>
                <p>{study.lifecycle === 'draft' ? 'Run analysis to measure the actual voxel data at each site. Results and derived montages will appear here.' : 'No results have been accepted for this site yet. Other sites can continue independently.'}</p>
                <dl><dt>Checks</dt><dd>Loadability, finite voxels, nonempty signal, internal blank slices</dd><dt>Shared evidence</dt><dd>Bounded PNG montages, descriptive measurements, and provenance</dd><dt>Not measured</dt><dd>Diagnosis, motion scores, brain volume, or clinical quality</dd></dl></>}
            </section>
          </div>
          <section className="activity"><h2>Study activity</h2><p className="muted small">Measurements, agent suggestions, and human decisions are separate records.</p><ol>
            <li><time>{date(study.created_at)}</time><span>Study created · fixed workflow and dataset snapshot</span></li>
            {[...all].sort((a, b) => a.provenance.timestamp.localeCompare(b.provenance.timestamp)).map(r => <li key={`${r.site_id}:${r.acquisition_id}`}><time>{date(r.provenance.timestamp)}</time><span>{siteName(r.site_id)} · {r.acquisition_id} · {r.checks_passed ? 'Checks passed' : `${r.findings.length} failed check(s)`}</span></li>)}
            {Object.entries(study.investigations).map(([key, j]) => <li key={key}><span>Agent · {key} · {j.state}{j.proposal && ` · suggests ${j.proposal.action} · ${j.proposal.tool_calls} tool calls · ${j.proposal.model}`}</span></li>)}
            {Object.entries(study.decisions).map(([key, d]) => <li key={key}><time>{date(d.at)}</time><span>Human · {key} · {d.action}: {d.reason}</span></li>)}
          </ol></section>
        </>}
    </main><footer>Simulated sites · Public research data · Not for clinical use</footer>
  </>;
}

function TitleForm({ initial, label, submit, disabled, onSubmit }: { initial: string; label: string; submit: string; disabled: boolean; onSubmit: (title: string) => void }) {
  const [title, setTitle] = useState(initial);
  return <form onSubmit={e => { e.preventDefault(); if (title.trim()) onSubmit(title); }}><label htmlFor="title">{label}</label><input id="title" required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} />
    <button disabled={disabled || !title.trim()}>{submit}</button></form>;
}
function Reopen() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  return <form onSubmit={e => { e.preventDefault(); try {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !/^\/studies\/[0-9a-f-]{36}$/.test(target.pathname)) throw Error();
    location.assign(target.pathname);
  } catch { setError('Enter a study URL from this workspace.'); } }}><h2>Reopen a study</h2><label htmlFor="study-url">Known study URL</label><input id="study-url" value={url} onChange={e => setUrl(e.target.value)} required placeholder="Paste a study URL" /><button className="secondary">Open study</button>{error && <p role="alert">{error}</p>}</form>;
}
function Row({ label, children }: { label: string; children: ReactNode }) { return <><dt>{label}</dt><dd>{children}</dd></>; }
function Review({ study, result, disabled, decide }: { study: StudyView; result: ScanResult; disabled: boolean; decide: (extra: object) => void }) {
  const key = `${result.site_id}:${result.acquisition_id}`;
  const job = study.investigations[key];
  const proposal = job?.proposal;
  const decision = study.decisions[key];
  const [reason, setReason] = useState('');
  useEffect(() => { setReason(proposal?.reason ?? ''); }, [proposal?.reason]);
  if (result.checks_passed) return null;
  return <section className="review" aria-label="Finding resolution"><h2>Finding resolution</h2>
    {decision ? <p className="notice">Human decision: <strong>{decision.action === 'replace' ? `Replaced with ${decision.candidate_id}` : 'Subject excluded'}</strong> · {decision.reason}</p>
      : !proposal ? <p role="status">{job?.state === 'error' ? 'Investigation failed; no proposal was invented. Use Retry investigation.' : job?.state === 'investigating' ? 'Investigating locally · bounded to 10 tool calls and 2 minutes. No human decision yet.' : 'Awaiting local investigation. No replacement or exclusion decision yet.'}</p>
      : <><p className="eyebrow">Agent suggestion · Not a human decision · {proposal.model}</p><p>{proposal.reason}</p>
        </>}
    {proposal && <details><summary>Tool-backed investigation ({proposal.tool_calls} calls)</summary><ol>{proposal.trace.map((t, i) => <li key={i}><code>{t.tool}({Object.values(t.arguments).join(', ')})</code><pre>{JSON.stringify(t.output, null, 2)}</pre></li>)}</ol></details>}
    {proposal?.candidate && <div className="comparison"><h3>Original / {decision?.action === 'replace' ? 'approved' : 'proposed'} retest</h3><div className="comparison-images">{[result, proposal.candidate].map(r => <figure key={r.acquisition_id}><figcaption>{r.acquisition_id} · {r.checks_passed ? 'Checks passed' : 'Flagged original'}</figcaption>{r.evidence.status === 'ready' && <img src={`/api/studies/${study.id}/evidence/${r.evidence.artifact_id}`} alt={`${r.acquisition_id} comparison montage`} />}</figure>)}</div><details><summary>Retest measurements and provenance</summary><Scan study={study} result={proposal.candidate} /></details></div>}
    {!decision && proposal && <><label htmlFor="decision-reason">Human decision reason (required)</label><textarea id="decision-reason" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} />
        <div className="toolbar">{proposal.candidate && <button disabled={disabled || !reason.trim()} onClick={() => decide({ findingId: key, action: 'replace', reason, candidateId: proposal.candidate!.acquisition_id })}>Approve replacement</button>}
          <button className="secondary" disabled={disabled || !reason.trim()} onClick={() => decide({ findingId: key, action: 'exclude', reason, candidateId: null })}>Exclude subject</button><span className="small muted">Leave unresolved: make no decision.</span></div></>}
    <h3>Retained original evidence</h3>
  </section>;
}
function Scan({ study, result: r }: { study: StudyView; result: ScanResult }) {
  const [imageError, setImageError] = useState(false);
  const [reload, setReload] = useState(0);
  const m = 'shape' in r.measurements ? r.measurements : undefined;
  const evidence = r.evidence;
  const transformation = r.provenance.synthetic_transformation;
  return <>
    <div className="title-line"><p className="eyebrow">{siteName(r.site_id)} / {r.acquisition_id}</p>{transformation && <span className="tag">Synthetic corruption</span>}</div>
    <h2 className="finding-title">{r.checks_passed ? 'Checks passed' : r.findings.some(f => f.code === 'INTERNAL_BLANK_SLAB') ? 'Internal blank slices' : r.findings.some(f => f.code === 'DEGENERATE_SIGNAL') ? 'No usable signal' : 'Integrity checks flagged'}</h2>
    <p>{r.checks_passed ? 'This acquisition passed the fixed integrity checks.' : 'This original failed integrity checks and is not included. Its findings and evidence are retained regardless of the human resolution.'}</p>
    {r.findings.length > 0 && <ul className="findings">{r.findings.map(f => <li key={f.code}><strong>{f.code.replaceAll('_', ' ')}</strong>{f.intervals_z && ` · Canonical axial slices ${f.intervals_z.map(([a, b]) => `${a}–${b}`).join(', ')}`}{f.count !== undefined && ` · ${f.count} voxels`}</li>)}</ul>}
    {transformation && <p className="muted small">Synthetic fixture: {transformation.type === 'zero_all_voxels' ? 'all voxel intensities were set to zero.' : `canonical axial slices ${transformation.start}–${transformation.end_inclusive} were set to zero. All detected intervals remain visible, including additional heuristic flags.`}</p>}
    <figure>{evidence.status === 'ready' ? imageError ? <div className="evidence-message"><p>Preview could not be loaded. Accepted evidence remains stored in this study.</p><button className="secondary" onClick={() => { setImageError(false); setReload(n => n + 1); }}>Reload preview</button></div>
      : <a href={`/api/studies/${study.id}/evidence/${evidence.artifact_id}`} target="_blank" rel="noreferrer" aria-label="Open full-size derived montage"><img key={reload} src={`/api/studies/${study.id}/evidence/${evidence.artifact_id}?reload=${reload}`} onError={() => setImageError(true)} alt={`Derived MRI montage for ${r.acquisition_id}; ${evidence.slices.map(s => `${s.plane} slice ${s.index}`).join(', ')}`} /></a>
      : <div className="evidence-message"><h3>{evidence.status === 'missing' ? 'Preview missing' : 'Volume cannot be rendered'}</h3><p>{evidence.error}</p>{evidence.status === 'missing' && <p>Preview-only retry is deferred. Site retry reruns analysis; it does not change inclusion.</p>}</div>}
      <figcaption>Derived montage · Not a full-volume viewer{evidence.status === 'ready' && ` · ${(evidence.bytes / 1024).toFixed(1)} KiB · Open image for full size`}</figcaption>
    </figure>
    <h3>Descriptive measurements</h3><dl>
      <Row label="Canonical shape">{m?.shape.join(' × ') ?? 'Unavailable'}</Row>
      <Row label="Voxel spacing (mm)">{m?.voxel_spacing_mm.map(n => n.toFixed(3)).join(' × ') ?? 'Unavailable'}</Row>
      <Row label="Nonfinite voxels">{m ? `${m.nonfinite_count} (${(m.nonfinite_fraction * 100).toFixed(3)}%)` : 'Unavailable'}</Row>
      <Row label="Foreground fraction">{m?.foreground_fraction == null ? 'Unavailable' : `${(m.foreground_fraction * 100).toFixed(2)}%`}</Row>
      <Row label="Foreground extent (mm)">{m?.foreground_bbox_extent_mm?.map(n => n.toFixed(2)).join(' × ') ?? 'Unavailable'}</Row>
    </dl><p className="small muted">Foreground is a signal proxy, not brain volume, segmentation, SNR, or a clinical quality grade.</p>
    <details><summary>Provenance and rendering parameters</summary><dl>
      <Row label="Workflow">{r.provenance.pipeline_version}</Row><Row label="Input SHA-256"><code>{r.input_sha256}</code></Row>
      <Row label="Source SHA-256"><code>{r.provenance.source.sha256}</code></Row>
      <Row label="Source">{r.provenance.source.dataset} · {r.provenance.source.version} · {r.provenance.source.license}</Row>
      <Row label="Attribution">{r.provenance.source.authors}</Row><Row label="Dataset DOI">{r.provenance.source.doi}</Row>
      <Row label="Measured at">{date(r.provenance.timestamp)}</Row><Row label="Tool exit status">{r.provenance.tool_exit_status}</Row>
      <Row label="Parameters">2nd–98th percentile window; foreground &gt; 0.10; slice support ≥ 1%; blank run ≥ 2 slices</Row>
      {evidence.status === 'ready' && <><Row label="Rendering window">{evidence.intensity_window.join(' – ')}</Row><Row label="Slices">{evidence.slices.map(s => `${s.plane}: ${s.index}`).join('; ')}</Row></>}
      <Row label="Packages">{Object.entries(r.provenance.packages).map(([name, version]) => `${name} ${version}`).join(' · ')}</Row>
    </dl></details>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
