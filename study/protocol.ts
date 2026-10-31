import { z } from 'zod';

export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .refine(value => !['__proto__', 'constructor', 'prototype', 'finished', 'error'].includes(value));
export const siteId = z.string().regex(/^site-[a-z]$/);
export const MAX_PREVIEW_BYTES = 150 * 1024;
export const NO_PROGRESS_MS = 5 * 60 * 1000;
export const selectedSchema = z.object({
  acquisition_id: id, subject_id: id, input_sha256: hash, source_sha256: hash,
}).strict();
export const studyInputSchema = z.object({
  study_id: z.uuid(), title: z.string().trim().min(1).max(160), owner_id: id,
  sites: z.array(z.object({
    site_id: siteId, manifest_sha256: hash,
    selected: z.array(selectedSchema).min(1).max(6),
  }).strict()).min(1).max(3),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.sites.map(s => s.site_id)).size !== input.sites.length ||
      input.sites.reduce((n, s) => n + s.selected.length, 0) > 6 ||
      input.sites.some(s => new Set(s.selected.map(a => a.acquisition_id)).size !== s.selected.length ||
        new Set(s.selected.map(a => a.subject_id)).size !== s.selected.length)) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate identities or too many selected scans' });
  }
});
export type StudyInput = z.infer<typeof studyInputSchema>;

export const requestSchema = z.object({
  schema_version: z.literal(1), type: z.literal('analyze_site'),
  message_id: z.uuid(), request_id: z.uuid(), study_id: z.uuid(), site_id: siteId, attempt_id: z.uuid(),
  payload: z.object({ workflow_version: z.literal('mri-integrity-v1'), manifest_sha256: hash }).strict(),
}).strict();
export type AnalysisRequest = z.infer<typeof requestSchema>;

const pair = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const triple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const window = z.tuple([z.number().finite(), z.number().finite()]);
const errorCode = z.enum(['UNREADABLE_IMAGE', 'UNSUPPORTED_VOLUME', 'INVALID_GEOMETRY', 'NO_FINITE_VALUES']);
const evidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), artifact_id: hash, sha256: hash,
    media_type: z.literal('image/png'), bytes: z.number().int().positive().max(MAX_PREVIEW_BYTES),
    slices: z.array(z.object({ plane: z.enum(['sagittal', 'coronal', 'axial', 'axial (slab evidence)']),
      axis: z.number().int().min(0).max(2), index: z.number().int().nonnegative() }).strict()).min(3).max(30),
    intensity_window: window,
  }).strict().refine(e => e.artifact_id === e.sha256),
  z.object({ status: z.literal('missing'), error: z.literal('PREVIEW_FAILED') }).strict(),
  z.object({ status: z.literal('unrenderable'), error: errorCode }).strict(),
]);
const text = z.string().max(512);
export const resultSchema = z.object({
  schema_version: z.literal(1), site_id: siteId, subject_id: id, acquisition_id: id, input_sha256: hash,
  checks_passed: z.boolean(),
  findings: z.array(z.object({ code: z.enum(['UNREADABLE_IMAGE', 'UNSUPPORTED_VOLUME', 'INVALID_GEOMETRY',
    'NONFINITE_VALUES', 'DEGENERATE_SIGNAL', 'EMPTY_FOREGROUND', 'INTERNAL_BLANK_SLAB']),
    count: z.number().int().nonnegative().optional(), intervals_z: z.array(pair).max(100).optional(),
  }).strict()).max(16),
  measurements: z.object({
    orientation: z.array(z.enum(['R', 'A', 'S', 'L', 'P', 'I'])).length(3),
    shape: z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]),
    voxel_spacing_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    nonfinite_count: z.number().int().nonnegative(),
    nonfinite_fraction: z.number().min(0).max(1),
    foreground_fraction: z.number().min(0).max(1).nullable(),
    foreground_bbox_extent_mm: triple.nullable(), intensity_window: window.nullable(),
    blank_slab_intervals_z: z.array(pair).max(100),
  }).strict().or(z.object({}).strict()),
  evidence: evidenceSchema,
  provenance: z.object({
    pipeline_version: z.literal('mri-integrity-v1'),
    parameters: z.object({ percentiles: z.tuple([z.literal(2), z.literal(98)]),
      foreground_threshold: z.literal(0.10), supported_slice_fraction: z.literal(0.01), minimum_blank_run: z.literal(2),
    }).strict(),
    packages: z.object({ python: text, nibabel: text, numpy: text, matplotlib: text, pillow: text }).strict(),
    timestamp: z.iso.datetime({ offset: true }), tool_exit_status: z.literal(0),
    source: z.object({ dataset: text, version: text, git_commit: z.string().regex(/^[a-f0-9]{40}$/),
      doi: text, license: text, authors: text, publication: z.url().max(512), acquisition: id.or(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)), sha256: hash,
    }).strict(),
    synthetic_transformation: z.union([
      z.object({ type: z.literal('zero_internal_slab'), axis: z.literal('RAS-z'), start: z.number().int().nonnegative(), end_inclusive: z.number().int().nonnegative() }).strict(),
      z.object({ type: z.literal('zero_all_voxels') }).strict(),
      z.null(),
    ]),
  }).strict(),
}).strict().refine(r => r.checks_passed === (r.findings.length === 0), 'Checks and findings disagree')
  .refine(r => r.evidence.status !== 'unrenderable' || !r.checks_passed, 'Unrenderable scans cannot pass')
  .refine(r => Object.keys(r.measurements).length > 0 ||
    (r.evidence.status === 'unrenderable' && r.evidence.error !== 'NO_FINITE_VALUES'), 'Measurements required');
export type ScanResult = z.infer<typeof resultSchema>;
const envelope = { schema_version: z.literal(1), message_id: z.string().min(1).max(160),
  request_id: z.uuid(), study_id: z.uuid(), site_id: siteId, attempt_id: z.uuid() };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('scan_result'), payload: z.object({ result: resultSchema, elapsed_ms: z.number().nonnegative().max(120000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('site_finished'), payload: z.object({ selected_count: z.number().int().min(1).max(6) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('job_error'), payload: z.object({ code: z.literal('SITE_ANALYSIS_FAILED') }).strict() }).strict(),
]);
export type SiteEvent = z.infer<typeof eventSchema>;

export function decodeEvent(text: string): SiteEvent {
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error('OVERSIZED_EVENT');
  return eventSchema.parse(JSON.parse(text));
}
