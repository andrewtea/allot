import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { studyInputSchema } from '../study/protocol.ts';
import type { Study } from '../study/state.ts';
import { actors } from './generated/index.js';
import type { Coordinator } from './coordinator.ts';

const authSchema = z.object({
  origin: z.url().refine(value => new URL(value).origin === value && new URL(value).protocol === 'https:'),
  credential: z.string().min(24), sessionSecret: z.string().min(32),
}).strict();
const configSchema = authSchema.extend({ sites: studyInputSchema.shape.sites });
export type BrowserConfig = z.infer<typeof configSchema>;

export function browserConfig(): BrowserConfig | undefined {
  const { BROWSER_CONFIG, APP_ORIGIN, DEMO_CREDENTIAL, SESSION_SECRET } = process.env;
  if (!BROWSER_CONFIG && !APP_ORIGIN && !DEMO_CREDENTIAL && !SESSION_SECRET) return;
  try {
    if (BROWSER_CONFIG) return configSchema.parse(JSON.parse(readFileSync(BROWSER_CONFIG, 'utf8')));
    return { ...authSchema.parse({ origin: APP_ORIGIN, credential: DEMO_CREDENTIAL, sessionSecret: SESSION_SECRET }), sites: [] };
  }
  catch { throw new Error('INVALID_BROWSER_CONFIG'); }
}

/** Deliberate browser projection: jobs, event payloads and evidence bytes stay server-side. */
export function studyView(study: Study) {
  return {
    id: study.input.study_id, title: study.input.title, revision: study.revision,
    created_at: study.created_at, lifecycle: study.lifecycle,
    workflow: 'mri-integrity-v1',
    sites: study.input.sites.map(site => ({
      id: site.site_id, selected: site.selected,
      state: study.sites[site.site_id]?.state ?? 'queued',
      error: study.sites[site.site_id]?.error ?? null,
      results: Object.values(study.sites[site.site_id]?.results ?? {}),
    })),
  };
}
export type StudyView = ReturnType<typeof studyView>;

export function studyActor(coordinator: Coordinator, id: string) {
  return actors.StudyActor.get(id, coordinator.transport);
}
