# MVP user specification: federated imaging study

Status: create/run/results browser phase implemented. A supervised three-site run through the deployed Render browser, managed Terse, hosted Relay, and three separate Freestyle VMs passed on 2026-10-31: six real MRI results, four passes, synthetic blank-slab and zero-signal findings, and six persisted previews totaling 383,305 bytes. Each site recorded one execution; the reservation released automatically and previous studies remained unchanged. New studies use all three sites; existing Drafts retain their creation snapshot. VM TTL/runtime limits and free Render sleep mean this is a temporary supervised demo, not unattended coordination. Local validation remains separate and uses in-memory messaging. Completed checks and remaining integration gates are recorded in the technical specification.

The hosted browser can operate in authentication-only mode before cloud agents are connected. After sign-in it shows **Cloud setup pending**, with study creation, analysis, and evidence unavailable; it does not display local results as cloud execution.

**Current phase, not full MVP acceptance:** researcher sign-in, creation, Draft title editing, run, per-scan measurements/previews/provenance, persistent study URLs, and site retry are available. Snapshots refresh every two seconds with a disconnected warning and last-successful timestamp. Reload preview retries retrieval of already-persisted evidence only; independent generation retry and direct managed subscriptions remain deferred. LLM investigation, human decisions, viewer links, finalization, and exports are not implemented. The demo releases sites after all analysis and required previews finish, preserving prior studies and allowing another run during review. Active or failed runs keep their reservation; a second study stays Draft until those finish or recover. U1–U6 below remain the target contract, not a claim that these deferred workflows exist.

Companion: [technical specification](MVP_TECHNICAL_SPEC.md). Event constraints: [HACKATHON.md](HACKATHON.md).

## At a glance

![Architecture and workflow: create, analyze locally, investigate, approve, and finalize](docs/architecture.png)

[Responsive architecture reference](docs/architecture.html). Read top to bottom: the researcher starts work, site agents exchange messages through Relay, and only permitted findings and derived previews enter the shared study record.

## 1. Product promise

Run one image-backed study across three simulated institutions, investigate problems where the scans live, and produce a traceable report after a researcher approves consequential decisions.

The first study asks: **Which scans satisfy our basic image-integrity checks, and what changes are necessary before we use this dataset?** It analyzes actual 3D MRI voxel arrays, not just manifests or screenshots. It does not answer a disease question or establish that scans are scientifically comparable for every downstream analysis.

The valuable interaction is the follow-up: a site agent finds a problem, looks for a compatible repeat acquisition, analyzes it, and proposes a resolution with evidence. The coordinator cannot directly inspect the site's raw files.

## 2. Decisions and boundaries

- Start with one free Render Web Service for the minimal server and hosting checks. The full web UI, backend, and coordinator will share that service. Free-tier idle spin-down can interrupt coordination, so unattended workflows require an approved paid upgrade or a revised execution design. No separate Vercel deployment or worker service is required; the full Render workflow remains to be validated.
- Managed Terse Durable Actors owns study state and live coordination. No self-hosting.
- Freestyle runs three isolated site environments, their agents, and Python analysis tools.
- Agent Relay carries coordinator/site requests and responses.
- No Supabase or separate application database.
- Use public research images and clearly labeled synthetic corruptions. All institutions are simulated and operated by the demo team; this is not proof of independent institutional control or medical privacy compliance.
- Raw MRI volumes remain in site environments during application operation. Approved derived slice previews may leave; they are still image-derived data, not inherently anonymous.
- Site workspaces persist across investigations; the app does not create a new VM for each scan. The application UI/backend runs separately from these workbenches. Operators may pause idle workspaces after finalization; retained reports do not depend on keeping compute running.
- One fixed, versioned analysis workflow. No free-form study builder or diagnostic chatbot.
- Anatomical segmentation, regional brain volumes, motion grading, and clinical interpretation are not MVP promises. Adding them requires a separately verified pipeline and a revision to both specs.

## 3. Users and access

**Researcher:** creates a study, runs analysis, reviews evidence, approves replacement/exclusion, retries failed sites, and exports a report.

**Viewer:** opens a study link and watches the same live state, evidence, decisions, and report. Cannot change anything. This is the participatory judge experience.

No signup or institutional onboarding. A server-configured demo researcher credential grants write access; the viewer link is a read-only bearer capability. The UI labels this as demo access, not production identity management. Share links only for the public-data demo.

## 4. Screens

1. **Start page:** new study form and an option to reopen a known study URL. No searchable study catalog.
2. **Study workspace:** title, workflow version, overall status, three site cards, selected/included/excluded/replaced counts, pending decisions, and a timestamped activity feed.
3. **Finding panel:** affected site and pseudonymous subject, failed check, numeric/tool evidence, labeled slice previews when available, investigation summary, and permitted resolution buttons.
4. **Report:** per-site counts, retained measurements, resolved failures and exclusions/replacements with reasons, provenance, and export controls. Available only after finalization; unresolved work stays in the workspace.

Always show “Simulated sites · Public research data · Not for clinical use.” A preview is a derived montage, not an interactive full-volume viewer. Display rendering errors explicitly; do not replace missing evidence with a generated image.

## 5. Exact workflows

### U1 — Create and start a study

1. Researcher opens the app, enters the operator-provided demo credential, and clicks **Sign in**. An invalid credential shows an error without granting access. Viewer links do not require this login.
2. Clicks **New study**, enters a title, and sees the fixed workflow “MRI integrity review v1.”
3. Reviews three preconfigured sites and each site's selected scan count. All three are required; there is no site-provisioning UI.
4. Sees exactly what is shared: check results, pseudonymous scan identifiers, analysis provenance, and approved derived previews. No raw volumes or local filesystem paths.
5. Clicks **Create study**. The app opens a persistent study URL with status **Draft**.
6. Clicks **Run analysis**. Status becomes **Running**; each site progresses from queued to analyzing. Double-clicking does not start duplicate runs.

The title is editable only in Draft. The workflow and dataset snapshot are fixed at creation. A different protocol or dataset requires a new study; there is no mid-run protocol editor. If another study is using these sites, starting shows a busy error and leaves this study in Draft; retry after the other study finalizes.

### U2 — Watch real image analysis

1. Researcher watches site cards update without refreshing.
2. Opens a site card to see per-scan results: loadability, finite voxel values, nonempty signal, and suspicious internal blank slices.
3. Opens a scan to inspect axial/coronal/sagittal previews and descriptive foreground measurements.
4. A clear scan is labeled **Checks passed**, never “clinically normal” or “scientifically validated.” A flagged scan remains out of the final included set until resolved.
5. Activity entries distinguish tool measurements, agent explanations, and human decisions.

A site can finish while others are still running. Preliminary counts are labeled provisional and cannot be exported as a finalized report.

### U3 — Investigate and decide

1. A failed check triggers a local investigation automatically. The UI shows **Investigating**, then the evidence and recommended action.
2. If an alternate acquisition exists, the site agent checks its subject identity, modality, and protocol compatibility, then runs the same voxel analysis on it. It cannot approve its own substitution.
3. Researcher opens the finding panel and compares the original and proposed replacement, including both check results and previews if renderable.
4. Chooses **Approve replacement**, **Exclude subject**, or **Leave unresolved**. Replacement is offered only for an eligible, passing alternate; exclusion requires a written reason. Approval records a reason, with the proposal's explanation available as an editable default.
5. An approved replacement includes the alternate instead of the original, never both. Exclusion removes the subject's selected scan; it does not delete source files.
6. With no suitable alternate, only exclusion or leaving unresolved is offered. Unreadable originals still show the error even when they cannot produce a preview.

All failed checks for one selected acquisition are grouped into one review item. Replacement or exclusion resolves that whole item; the researcher cannot make contradictory decisions for separate checks on the same scan. Failed alternate candidates are investigation evidence, not additional subjects requiring exclusion.

An agent can propose and explain; only researcher approval changes inclusion after a finding. Leaving unresolved makes no decision and keeps finalization blocked. There is no “include anyway” override for failed checks in v1.

### U4 — Handle interruptions and failures

- Reloading or reopening the study restores its current state, findings, and decisions.
- Closing the browser does not stop analysis or investigation. Restarting or redeploying the Render service briefly interrupts application access and coordination; after recovery, persisted work resumes without duplicate analyses or lost approvals. This is a recovery contract, not a zero-downtime guarantee.
- If a site workspace is paused, starting or retrying work resumes it and waits for its agent to become ready. A resume failure is shown as a site error, never a successful analysis. A stopped workspace may take longer to recover because its processes must restart; deleted raw files are not promised recoverable.
- A disconnected viewer sees a connection warning and the last known timestamp. Reconnection fetches current state; it must not imply a stale screen is live.
- A site/tool/agent failure becomes **Error**, with a useful explanation and **Retry site** for the researcher. Completed sites remain intact.
- Retrying restarts only the failed site's attempt. It preserves valid findings and decisions tied to unchanged scan hashes and workflow version. A changed input is rejected rather than silently reusing a decision.
- A missing preview has a separate **Retry preview** action and does not rerun analysis or change inclusion. Previews are required for renderable selected scans and approved replacements, including rejected originals used as decision evidence; missing ones block finalization. Volumes that cannot be rendered retain their tool error instead.
- There is no cancel or site-skip control. A failed site must recover before finalization; a failed scan may be excluded through U3.

### U5 — Finalize and export

1. After every site finishes and all findings have approved resolutions, **Finalize report** becomes available. It remains disabled during analysis, site errors, unresolved findings, or missing required evidence.
2. If no scans remain included, finalization is blocked with “No scans remain; start a new study with usable inputs.”
3. Researcher reviews per-site selected/included/excluded/replaced counts and clicks **Finalize report**.
4. The report freezes the inclusion set, measurements, evidence previews, decisions, and workflow/input provenance. No further retries or decisions are accepted for this study.
5. Clicks **Download Markdown** for the readable report or **Download JSON** for the structured record. Downloads include approved derived previews (embedded in Markdown and as data URLs in JSON), not MRI volumes. They include source attribution and synthetic-fixture labels.

The report describes measured integrity checks and their limitations. It contains no disease-effect estimate, p-value, or claim of clinical suitability. A finalized report remains readable after a site VM is unavailable because its bounded evidence snapshot is persisted centrally. Raw-volume retention is not promised.

### U6 — Share and collaborate

1. Researcher clicks **Copy viewer link**.
2. A judge opens that link on another device and watches the same site progress, findings, approvals, and report.
3. Viewer controls for running, retrying, approving, and finalizing are absent, and equivalent write requests are rejected by the server.
4. Two researcher tabs may be open. If they attempt conflicting decisions, the first accepted decision wins; the other tab refreshes and explains that the finding was already resolved.

## 6. Demo dataset and story

Locally validated fixture: six selected T1-weighted MRI acquisitions, two per site, plus one compatible alternate for one selected subject. Source: CC0 OpenNeuro ds000114 version 1.0.2, subjects 01–06's test acquisitions and subject 03's actual retest. Source attribution, pinned downloads (about 64.9 MB total), and reproducible preparation commands are in the [README](README.md#public-fixture-and-attribution). Runtime and isolation in Freestyle remain to be verified.

- Site A: subjects 01 and 02; both pass the local integrity checks.
- Site B: subjects 03 and 04; subject 03 has a deliberately blanked internal slab at canonical axial slices 100–102, plus a passing retest acquisition. Blanking also shifts the percentile window and flags marginal slices 248–249; all flagged intervals stay visible as heuristic findings.
- Site C: subjects 05 and 06; subject 05 has deliberately zeroed signal and no alternate.

Expected walkthrough, after fixture checks: run all sites, inspect B's local investigation, approve B's replacement, exclude C's failed subject with a reason, and finalize. Final counts: six initially selected, five included, one excluded subject, one replacement. The rejected original at B is not counted as an additional excluded subject.

The corruptions are labeled synthetic in UI and exports. They demonstrate checks and workflow, not real-world detection accuracy. A second validation scenario removes B's alternate: the agent must not claim a replacement exists.

## 7. Acceptance contract

- U1–U6 work on the real integrations; a scripted chat transcript or canned measurement is not a substitute.
- Actual pixel data is read and measured at each site. The blank-slab and zero-signal fixtures produce the corresponding findings.
- Adaptive investigation uses available local evidence; changing alternate availability changes the proposed action.
- Approval changes the inclusion set exactly once. No unresolved/failed site is silently dropped.
- Two connected browsers converge on the same state; refresh and interrupted delivery do not lose approvals.
- A viewer cannot write; raw scans and unrestricted local paths never appear in coordinator messages or exports.
- Exported numbers, evidence, and provenance agree with the final workspace. Evidence remains available if a VM stops.

## 8. Explicit non-goals

Clinical diagnosis, validated clinical QC, anatomical segmentation, arbitrary code execution requested by users, raw uploads, DICOM/PACS integration, real patient data, independent institutional onboarding, privacy/compliance certification, general statistical harmonization, chat-based protocol changes, account management, multi-study search, indefinite storage, cancellation, and production-scale fault tolerance.
