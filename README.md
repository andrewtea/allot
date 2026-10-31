# Allot

Image-backed integrity review across simulated research sites. Public research
data only; not for clinical use.

Implemented: **site-local analysis, reproducible MRI fixtures, durable Relay
runners, Terse study actors, coordinator recovery, and an authenticated browser
create/run/results/retry screen**. The runner has passed a
live single-site Freestyle/hosted Relay gate. Actor/coordinator tests run against
real local Terse. The browser can be hosted on free Render in authentication-only
mode while cloud study services are unconfigured. A supervised **three-site cloud
browser run** has now passed with managed Terse, hosted Relay, and real MRI
analysis in three separate Freestyle VMs. Bounded model investigation, researcher
replacement/exclusion decisions, and frozen Markdown/JSON exports are implemented.
Contracts: [user spec](MVP_USER_SPEC.md)
and [technical spec](MVP_TECHNICAL_SPEC.md).

The browser follows the [frontend design direction](docs/frontend-design.md):
flat site rows, a split evidence pane, and self-hosted OFL Manrope / DM Sans.

## Investigation, resolution, and report

New studies automatically investigate flagged originals after obtaining a fresh
pool reservation. Legacy result-only studies require **Investigate findings**;
deploying does not automatically spend their VM/model budgets. The real site model
chooses among `list_alternates`, `compare_acquisitions`, `analyze_scan`, and
`get_evidence`. Each investigation is bounded to ten tools, eight model requests,
1,800 output tokens per request, and two minutes. Only passing, compatible,
hash-verified alternatives can be proposed. Tool/model failure produces an error,
not a fallback proposal; **Retry investigation** creates a fresh attempt.

Suggestions do not change inclusion. Review original/retest evidence, edit the
required reason, and click **Approve replacement** or **Exclude subject**. Taking
no action leaves the finding unresolved. Decisions use revision checks and stable
command IDs. **Finalize report** freezes a fully resolved study with at least one
included subject and persisted evidence. **Download Markdown / JSON** include
original results, replacement analysis, human reasons, provenance, synthetic
disclosures, per-site counts, and all accepted embedded PNGs.

### Verified live completion

The [finalized cloud study](https://allot-1dzm.onrender.com/studies/6270ea4d-1a0c-4433-8a0e-1bc4a287c146)
completed at revision 16 on 2026-10-31. Render runtime `6657de7` (deployment
`dep-dbj6v9mtlv9c73cd8c00`) uses the updated managed actors and actual site runners.
B's model called list → compare → analyze and proposed its actual passing retest;
C's model called list and proposed exclusion from an empty alternate search.
Both proposals remained unresolved until explicit researcher-session UI actions.
The resulting report has **six selected, five included, one excluded and one
replacement**, retaining all six original results and seven hash-verified PNGs
totaling **445,460 bytes**. Markdown/JSON exports returned 200 and contained all
seven embedded previews. Three attempted finalized mutations returned 409.

Each site ledger recorded one completed analysis execution; B/C additionally
recorded one completed investigation execution. All 3/4/4 outbox events were sent.
After an empty-reservation check and `sync`, all three VMs were paused. Exports
remained byte-identical and all seven authenticated PNG routes still matched
their hashes. Earlier studies `447ead65…` and `8e2d16f5…` remain unchanged at
revision 10 with six previews each.

**Budget warning:** after pausing, total runtime was A 1,918 / B 3,347 / C 1,921
seconds against unchanged 3,600-second lifetime caps. B has only **253 seconds**
remaining. Use the finalized report for a durable demo; a new run automatically
resumes VMs and consumes their remaining budget. No caps, paid plans or VM counts
were increased. Free Render can still sleep after 15 idle minutes.

Local validation used real OpenAI `gpt-4.1-mini-2025-04-14`, Python/SQLite/Terse,
and explicitly in-memory messaging: B discovered/analyzed its actual retest;
C's empty alternate search proposed exclusion. Removing B's alternate from a
separate tool context changed its real model proposal to exclusion. Browser
approvals/finalization produced six selected, five included, one excluded, one
replacement, six retained originals and seven embedded PNGs. Both exports and
counts survived a full local process restart. This is distinct from cloud E2E.

Existing B/C Freestyle model gates passed HTTP 200 with placeholder guest keys;
the edge injects the provider key only for `POST /v1/responses`, fixes the model
to `gpt-4.1-mini`, caps output at 1,800 tokens, and sets `store:false`. Unmatched
`GET /v1/models` returned 401 at both sites. Node trusts the system CA bundle;
certificate verification remains enabled. No provider key is stored in a guest
or snapshot. Local development uses the orb's `OPENAI_API_KEY` directly; without
one investigations fail explicitly, rather than using a canned agent.

Deferred: viewer capabilities/live consoles, direct managed subscriptions,
independent preview generation retry, cross-attempt tool caching, full managed
restart/failure recovery proof, and unattended coordination on sleeping Render.

## Supervised cloud demo

The existing [live study](https://allot-1dzm.onrender.com/studies/447ead65-2cc4-4fe9-a3a5-443bb15761ae)
requires the privately supplied researcher credential. On 2026-10-31, browser
create → run executed all three sites' actual Python/SQLite runners over hosted
Relay, with a separate VM and Relay workspace per simulated site. Six scans
returned four passes and two findings: B's synthetic sub-03 blank slices
100–102 plus heuristic interval 248–249, and C's synthetic sub-05 zero signal.
Managed Terse revision 10 persisted six hash-verified PNG previews (383,305 bytes).
Each site's ledger recorded one completed execution and three sent outbox events.
Reload restored all results; all six preview routes returned 200 with matching
hashes after the VMs were paused. Earlier one-site studies remain unchanged.
No raw volumes were retrieved centrally.

Use **New study** to create a six-scan run; an older Draft keeps its original
immutable site snapshot. Sites A/C were prepared from fresh `freestyle/ubuntu-sm`
VMs, not cloned from populated B. Each VM has a 24-hour TTL, 30-minute per-run
cap, and one-hour total runtime budget. Existing B's limits were not extended.
All were paused after validation; new analysis resumes them. No paid plan was
upgraded. These limits bound this temporary demo, not indefinite availability.
Flush guest writes with `sync` before operator pause; fresh guest files were not
visible through paused filesystem reads until flushed. Inspect VM state after
filesystem reads rather than assuming a read cannot wake it.

Free Render can sleep; this demonstrates supervised execution, not unattended
coordination. Sites are
released automatically after all analysis and required previews finish, allowing
another study without deleting previous results. Failed runs retain the pool
for site retry; active runs cannot overlap. Follow-up investigation obtains its
own fresh reservation; completed review does not retain the VMs. Collaboration
and viewer capabilities remain deferred.

## Local development

Use Python 3.11+, [uv](https://docs.astral.sh/uv/), and Node 22.18+. These commands
need no provider credentials and create no cloud resources. The runner test uses
the real Python pipeline and SQLite with an in-memory messaging boundary:

```bash
uv sync --locked
uv run pytest -q
uv run ruff check analysis tests
uv run ruff format --check analysis tests
npm ci
npm run check
npm run build
npm test
```

## Browser study screen

Prepare all three public fixtures below, then run `npm run build` and
`npm run dev:local`. This starts authenticated **local Terse**, the coordinator,
three real Python/SQLite runners, and HTTP on `PORT` (default 3000). It uses
**in-memory messaging, not hosted Relay or Freestyle**; no cloud credentials
are used and no resources are provisioned. Bun 1.4.2+ is required. Private
demo access/signing material is generated once in `.local/browser/access.json`
(mode 0600); use its `credential` value in the sign-in form, never paste it in
chat or commit it. `APP_ORIGIN` sets the exact public origin for CSRF protection
and Secure cookies; it defaults to the local HTTP address only for development.

In an Amp orb, use a supervised portal:

```bash
amp orb service start allot --command 'APP_ORIGIN="$PUBLIC_URL" npm run dev:local' --port 3000 --portal --title 'Allot study workspace'
```

Open the printed portal, sign in, create a study, optionally edit its Draft
title, and run analysis. Select a site/acquisition to inspect measurements,
all findings, actual montages, and provenance. The browser refreshes authenticated
snapshots every two seconds and marks failures disconnected with the last
successful timestamp. Reloading the study URL restores persisted state. A
network-failed command can be retried with its original ID. Site errors offer
**Retry site**; completed sites remain intact. **Reload preview** only retries
HTTP retrieval of already-persisted evidence, not image analysis.

Viewer links remain deferred. A missing generated preview
currently requires retrying its site's analysis; independent **Retry preview**
and direct managed WebSocket subscriptions are deferred. This is not full U4/U6
acceptance. The registry reserves the pool during analysis and failed-site
recovery, then releases it once all sites complete or need review with persisted
evidence. Previous study URLs and previews remain readable. No reset is needed.
For a separate **disposable local** validation pool, run
`node scripts/local-study.ts <private-state-directory> <prepared-fixture-directory>`
on another port. Do not delete an existing study's data to reuse the pool.

Local actors and runner ledgers persist in the private state directory. The
development adapter replays durable runner outboxes after restart because its
messaging queues are volatile. This is not evidence of cloud delivery or
cross-site isolation, and the orb is not a production host.

For the managed backend, `BROWSER_CONFIG` names a private JSON file with
`origin` (the exact HTTPS origin, without trailing slash), `credential`
(at least 24 characters), `sessionSecret` (at least 32 characters), and `sites`.
Generate random credential/signing values. Each site supplies `site_id`,
`manifest_sha256`, and `selected` entries containing `subject_id`,
`acquisition_id`, `input_sha256`, and `source_sha256`; no local paths. This
snapshot must match the immutable site manifests. Also configure the coordinator
as below, deploy the updated actors, and run `npm run build` before `npm start`.
Without a coordinator, browser configuration enables sign-in only: the UI shows
**Cloud setup pending** and authenticated study/evidence routes return 503
`CLOUD_NOT_CONFIGURED`. No local adapter is enabled by `npm start`.

For this authentication-only hosting phase, set server-only `APP_ORIGIN`
(exact HTTPS origin, no trailing slash), `DEMO_CREDENTIAL` (24+ random characters),
and `SESSION_SECRET` (32+ random characters) instead of `BROWSER_CONFIG`.
All three are required together. Keep both credentials stable and private;
never use frontend build variables. A coordinator also requires the private
site snapshot in `BROWSER_CONFIG`; it cannot start with the empty hosting snapshot.
Enabling shared cloud infrastructure requires separate approval.

HTTP routes are `POST/GET/DELETE /api/session`, `POST /api/studies`,
`GET /api/studies/:id`, `POST /api/studies/:id/title`,
`POST /api/studies/:id/start`, `POST /api/studies/:id/sites/:site/retry`, and
`GET /api/studies/:id/evidence/:sha256`. Follow-up routes are
`POST /api/studies/:id/investigate`, `POST /api/studies/:id/decide`,
`POST /api/studies/:id/finalize`, and finalized-only `GET /api/studies/:id/export.md`
or `export.json`. Writes require the configured Origin and
JSON; every study/evidence request requires a signed 12-hour HttpOnly session.
Actor jobs, provider keys, and raw volumes are never returned to the browser.
There is no viewer capability endpoint yet. Login throttling is process-local
demo protection, not production account security.

Browser validation on 2026-10-31 used real local actors/Python/SQLite and simulated
messaging: six scans, four passes, two flagged, six hash-verified PNGs totaling
383,305 bytes. A missing Site B fixture caused a real tool failure; restoring it
and clicking Retry site recovered B without changing A/C results. Reload and
process restart preserved all six results. Browser checks also cover invalid
login, Draft editing, running, busy-pool rejection, image retrieval failure,
disconnection/reconnection, and 390px list/detail layouts. These local checks are
separate from the supervised cloud run above; the later investigation validation
is documented separately above.

## HTTP bootstrap and free Render

Without any browser authentication configuration, `npm start` runs the HTTP
bootstrap on `0.0.0.0` and `PORT` (default 3000). `GET /`
returns an explicit bootstrap status, and `GET /healthz` returns
`{"status":"ok"}`. Both support HEAD. Unknown routes return 404; writes to these
read-only endpoints return 405. SIGTERM/SIGINT stop accepting connections and
allow up to ten seconds to finish requests. The health check proves only HTTP
liveness, not readiness of Terse, Relay, Freestyle, or a study workflow.

`render.yaml` defines one **free** Node web service with Node 24.22.1 pinned in
`.node-version`, build command `npm ci --include=dev && npm run check && npm run build`,
start command `npm start`, and health check `/healthz`. The build includes the React
assets. Native Node TypeScript support
runs the server without a compilation artifact. Auto-deploy is disabled so a
Git push alone does not deploy future changes. Authentication-only hosting needs
the three browser variables above but no provider credentials: do not attach
the existing `allot-demo` secret group yet.

Free Render sleeps after 15 minutes without inbound traffic. This is suitable
for initial hosting checks and supervised development, **not** the uninterrupted
coordinator contract. Relay polling is outbound and does not prevent sleep;
browser subscriptions to Terse do not reach Render. Before unattended execution,
upgrade compute with approval or revise the coordinator design. No authoritative
study state or evidence may depend on Render's ephemeral filesystem.

## Prepare the public fixture

Prepare each site's fixture independently (about 64.9 MB downloaded in total):

```bash
uv run python -m analysis.prepare_fixture --site a --output .local/sites/a
uv run python -m analysis.prepare_fixture --site b --output .local/sites/b
uv run python -m analysis.prepare_fixture --site c --output .local/sites/c
```

Each command checks the downloaded files against the pinned source snapshot,
analyzes the unmodified acquisitions, creates the labeled synthetic derivatives,
and validates their actual voxel results and PNG evidence. It writes a local
`manifest.json`, `validation.json`, and content-addressed `evidence/*.png`.
Preparation is an offline setup step: **do not run it on an active study's
dataset**. In deployment run each command only inside its assigned site VM;
keeping all three fixtures in this orb is development validation, not proof of
site isolation. Raw volumes and generated artifacts are ignored by Git.

Analyze one acquisition using its manifest identity (never an agent-provided path):

```bash
uv run python -m analysis.integrity \
  --dataset-root .local/sites/b \
  --manifest .local/sites/b/manifest.json \
  --acquisition-id sub-03-test \
  --evidence-dir .local/sites/b/evidence
```

The CLI emits JSON measurements, findings, provenance, and artifact IDs. Exit 0
means the tool completed, **not** that the scan passed. Integrity failures are
findings; input/hash failures exit 1 with a safe error code. A missing preview
is retryable and distinct from an unrenderable volume. Future finalization must
check evidence readiness separately from `checks_passed`.

## Public fixture and attribution

Source: **Gorgolewski KJ, Storkey A, Bastin ME, Whittle IR, Wardlaw JM, Pernet CR**,
*A test-retest fMRI dataset for motor, language and spatial attention functions*.
[Dataset DOI](https://doi.org/10.18112/openneuro.ds000114.v1.0.2),
[publication](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3641991/).

The dataset declares [CC0 in its versioned metadata](https://github.com/OpenNeuroDatasets/ds000114/blob/6299834614e9ae7df1e2fc5922545331b5c7f022/dataset_description.json).
Preparation pins the 1.0.2 Git snapshot and checks its git-annex size/MD5 against
the public S3 downloads, then records SHA-256 for every source and derived input.
License, authors, source version, source hash, and transformations accompany results.

| Site | Selected acquisitions | Synthetic modification | Alternate |
| --- | --- | --- | --- |
| A | Subjects 01, 02; test session | None | None |
| B | Subjects 03, 04; test session | Subject 03: zero canonical axial slices 100–102 inclusive | Subject 03's actual retest acquisition |
| C | Subjects 05, 06; test session | Subject 05: zero every voxel | None |

All seven unmodified source acquisitions pass the implemented checks. The
synthetic B and C scans produce blank-slab and degenerate-signal findings,
respectively. The B alternate passes. Fixture validation alone is not evidence
of the approval workflow; the separate end-to-end validation is documented above.

**Heuristic limitation:** blanking B's slab changes the global percentile window;
the detector also flags marginal low-occupancy slices 248–249. Those findings
and their evidence are retained, not filtered to the known injected slab.
These checks do not establish anatomical coverage or clinical suitability.

## Site runner and live integration gate

The [technical spec's Relay setup notes](MVP_TECHNICAL_SPEC.md#headless-relay-setup-research)
identify the headless SDK, hosted endpoint, bootstrap keys, per-agent tokens,
and explicit delivery acknowledgement requirements. Hosted provisioning and
single-site messaging are now verified with SDK 15.0.1 / Relaycast 8.14.0.

`site/main.ts` consumes a private JSON configuration containing `siteId`,
`coordinatorId` (authenticated Relay ID), `coordinatorName`, `datasetRoot`,
`evidenceDir`, `projectRoot`, `python`, `database`, `relayBaseUrl`, and
`relayAgentToken`. The last value is **only that site's agent token**. Keep the
workspace admin key and all provider keys outside the VM. Run one consumer per
site; `site/allot-site.service` gives the tested Ubuntu installation paths.
Keep the manifest and inputs immutable during a study.

The runner accepts bounded `analyze_site` and `investigate_finding` requests, commits intake to SQLite
before ACK, and commits results plus a retryable outbox atomically. It rejects
conflicting request IDs and non-allowlisted senders. Completed commands are not
rerun; interrupted, uncommitted analysis can run again. This is not an
exactly-once execution guarantee. Study actors now provide stale-attempt
arbitration and reservations. Cross-attempt tool caching remains deferred.

`node scripts/check-site-integration.ts <private-config.json>` reruns the live
gate against **existing disposable resources**. It starts/stops the service,
injects two process crashes, sends test messages, resumes the VM, and leaves it
paused. Do not point it at an active study. The private config contains `vmId`,
`relayBaseUrl`, and `coordinator` / `site` objects each with `id`, `name`, `token`.
The VM must have metadata `purpose=integration-gate`, the project/dependencies
installed under `/srv/allot`, Python at `/opt/venv/bin/python`, and Site B prepared
under `/srv/allot/data`. The script uploads the current runner/analysis code,
but does not provision resources or prepare datasets. It requires the operator's
`FREESTYLE_API_KEY` in the orb and persists received events before acknowledging
them. Private configuration/results live under ignored `.local/integration`.

The authorized gate used one 2-vCPU/4-GiB VM and two Relay identities. Site B's
two selected scans took a median **4.948 seconds** across three executions;
the resumed service's peak cgroup memory was **354.3 MiB**. A 121,283-byte montage
was retrieved while paused and verified by SHA-256 and PNG signature. These are
single-site measurements, not full-MVP latency. Outbound HTTPS **and DNS** need
firewall rules; there is no public inbound service. The test VM is paused, not
deleted, with a 24-hour TTL, 30-minute continuous runtime cap, and one-hour total
runtime budget. The hosted workspace is retained; billing/retention guarantees
remain unverified. Additional cloud provisioning/deployment needs approval.

## Study actors

`src/actor.ts` implements the Terse study snapshot and demo-pool registry.
The actor persists analysis intent, accepted results and bounded PNG evidence;
retries create new attempt IDs, retain valid results, and reject late responses.
An early site-finished event cannot hide missing results. Missing previews block
completion. A durable five-minute no-progress alarm makes failed sites retryable.
Viewer sockets emit revisions only and reject client commands; authenticated
backend calls retrieve state. The browser routes above validate researcher
sessions before accessing the generated actor client.

Run `npm run actors:dev` for local actors and `npm run actors:generate` after
changing their contract. For an authorized managed deployment, use
`npm run actors:deploy -- <existing-project-id>` with server-only `TERSE_API_KEY`.
Add `--check` to inspect the source allowlist without deploying. This command
stages only actor source and package/typecheck metadata, then deletes the staging
directory. Do not run bare `terse deploy` from this working tree: CLI 0.14.9 does
not honor `.gitignore` and could upload private `.local` configuration or data.
Deployment replaces the project's published actor set; the disposable Counter
quickstart was replaced with explicit approval for this demo.

For local tooling, unset injected managed
`TERSE_API_KEY` / `TERSE_ACTOR_URL` so those credentials are not used locally.
Generated clients are checked in; do not edit them. `npm test` starts disposable,
authenticated local Terse runtimes and verifies persisted evidence after a full
runtime restart, reservations, retries, replay, and read-only WebSocket grants.
This requires Bun (1.4.2+) as well as Node and the Python test environment.

This implements the core study workflow, not all MVP collaboration/recovery gates.
Managed authentication and persistence have passed
for the three-site run above, including all six persisted previews; full managed
restart/recovery remains unverified.

## Coordinator

`server/coordinator.ts` exposes backend-only create/start operations and a
recoverable dispatch/intake loop. The registry reserves the demo pool before
start; a new coordinator finishes interrupted starts and resends stable requests.
Each site's Relay client validates the authenticated sender and site assignment.
Results are ACKed only after actor persistence; malformed/stale events are
terminally rejected through Relay. Transient processing errors are deferred and
retried. Duplicate results do not require the VM to remain available. A failed
site connection does not prevent another site's intake.

`npm start` opts into the coordinator only when `COORDINATOR_CONFIG` names a
private JSON file. Its `sites` array requires `siteId`, `vmId`, `agentId`,
`agentName`, `relayBaseUrl`, and `relayAgentToken` per site. The token is the
**coordinator identity's token in that site's workspace**, not the site's token
or a workspace admin key. Bind each token to its known HTTPS Relay origin.
Prefer separate workspaces for cross-site confidentiality. Also configure
server-only `TERSE_ACTOR_URL`, `TERSE_API_KEY`, and `FREESTYLE_API_KEY`.

Enabling this configuration permits the coordinator to resume the configured
VMs, check their existing `allot-site` systemd services, send analysis requests,
and read bounded PNGs only under `/srv/allot/data/evidence/<sha256>.png`.
It does not provision VMs, install runners, or deploy actors. Keep configuration
out of Git and obtain operational authorization before enabling it on shared
infrastructure. The credential-free HTTP bootstrap and its routes remain
unchanged when configuration is absent. SIGTERM stops polling and gives active
work up to ten seconds; unacknowledged work recovers after restart.

Validation on 2026-10-31: the six public-fixture scans traversed the coordinator,
real Python/SQLite runners, and real local Terse in **12.69 seconds**, producing
four passes, two flagged acquisitions, and six persisted previews totaling
**383,305 bytes**. Site A completed; B and C require review. This used in-memory
messaging, not a new cloud end-to-end run. Automated failure injection covers
lost send confirmations, lost ACKs, an unavailable peer workspace, missing
evidence recovery, and 205 duplicate deliveries. A separate real five-minute
alarm check transitioned a stalled site to `NO_PROGRESS_TIMEOUT` / `blocked`.
