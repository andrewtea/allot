# Allot

Image-backed integrity review across simulated research sites. Public research
data only; not for clinical use.

The first implementation is the **site-local analysis pipeline, reproducible MRI
fixture, and durable Relay runner**. The runner has passed a live single-site
Freestyle/hosted Relay gate, including crash recovery. A minimal HTTP server is
ready for a free Render bootstrap deployment. There is no application UI,
actor workflow, or LLM investigation yet. Contracts: [user spec](MVP_USER_SPEC.md)
and [technical spec](MVP_TECHNICAL_SPEC.md).

The [frontend design direction](docs/frontend-design.md) records the preferred
visual reference, layout rules, proposed tokens, and researched font options;
it is not an implemented UI.

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
npm test
```

## HTTP bootstrap and free Render

`npm start` runs the HTTP server on `0.0.0.0` and `PORT` (default 3000). `GET /`
returns an explicit bootstrap status, and `GET /healthz` returns
`{"status":"ok"}`. Both support HEAD. Unknown routes return 404; writes to these
read-only endpoints return 405. SIGTERM/SIGINT stop accepting connections and
allow up to ten seconds to finish requests. The health check proves only HTTP
liveness, not readiness of Terse, Relay, Freestyle, or a study workflow.

`render.yaml` defines one **free** Node web service with Node 24.22.1 pinned in
`.node-version`, build command `npm ci --include=dev && npm run check`, start
command `npm start`, and health check `/healthz`. Native Node TypeScript support
runs the server without a compilation artifact. Auto-deploy is disabled so a
Git push alone does not deploy future changes. The bootstrap needs no provider
credentials: do not attach the existing `allot-demo` secret group yet.

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
respectively. The B alternate passes. This validates the fixture, not the
unimplemented approval workflow or final inclusion counts.

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

The runner accepts bounded `analyze_site` requests, commits intake to SQLite
before ACK, and commits results plus a retryable outbox atomically. It rejects
conflicting request IDs and non-allowlisted senders. Completed commands are not
rerun; interrupted, uncommitted analysis can run again. This is not an
exactly-once execution guarantee. Study actors now provide stale-attempt
arbitration and reservations; tool caching and investigation remain unimplemented.

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
backend calls retrieve state. Researcher sessions and public study routes are
not implemented yet.

Run `npm run actors:dev` for local actors and `npm run actors:generate` after
changing their contract. For local tooling, unset injected managed
`TERSE_API_KEY` / `TERSE_ACTOR_URL` so those credentials are not used locally.
Generated clients are checked in; do not edit them. `npm test` starts disposable,
authenticated local Terse runtimes and verifies persisted evidence after a full
runtime restart, reservations, retries, replay, and read-only WebSocket grants.
This requires Bun (1.4.2+) as well as Node and the Python test environment.

This is the create/run/results foundation, not the complete study workflow.
Investigation, human decisions, finalization/releasing the active reservation,
and the UI still need implementation. Managed Terse deployment, actor capacity,
and managed authentication/persistence remain explicit deployment gates.
