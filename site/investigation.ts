import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resultSchema, proposalSchema, type ScanResult, type Proposal } from '../study/protocol.ts';

const entrySchema = z.object({ acquisition_id: z.string(), subject_id: z.string(), role: z.string(),
  modality: z.string(), protocol_id: z.string(), sha256: z.string() });
const argsSchema = z.record(z.string(), z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/));
const tools = [
  ['analyze_scan', 'Analyze the actual voxels of an acquisition', ['acquisitionId']],
  ['list_alternates', 'List manifest alternates for the affected subject', ['subjectId']],
  ['compare_acquisitions', 'Check subject, modality and protocol compatibility', ['originalId', 'alternateId']],
  ['get_evidence', 'Verify a generated PNG and return its metadata (not raw image data)', ['artifactId']],
].map(([name, description, keys]) => ({ type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties: Object.fromEntries((keys as string[]).map(key => [key, { type: 'string' }])),
    required: keys, additionalProperties: false } }));

/** Real Responses tool loop. The model chooses tools; code alone establishes eligibility. */
export async function investigate(options: {
  original: ScanResult; manifest: unknown; evidenceDir: string;
  analyze: (id: string, timeoutMs: number) => Promise<ScanResult>; apiKey: string; model: string;
}): Promise<Proposal> {
  const entries = z.object({ acquisitions: z.array(entrySchema) }).parse(options.manifest).acquisitions;
  const original = entries.find(e => e.acquisition_id === options.original.acquisition_id);
  if (!original || original.sha256 !== options.original.input_sha256) throw new Error('INPUT_MISMATCH');
  const trace: Proposal['trace'] = [];
  const analyzed = new Map<string, ScanResult>([[original.acquisition_id, options.original]]);
  const compared = new Set<string>();
  let listed = false;
  const deadline = Date.now() + 120_000;
  const input: unknown[] = [{ role: 'user', content: JSON.stringify({ task: 'Investigate this failed scan. Search alternates; verify compatibility and analyze candidates. Do not invent results. Explain all original findings, heuristic limitations and synthetic provenance. Return only JSON {action:"replace"|"exclude",candidateId:string|null,reason:string}. Replacement requires a passing compatible alternate; exclusion requires a completed search. Suggestions are NOT human decisions.', original: options.original }) }];
  let actualModel = '';
  for (let turn = 0; turn < 8; turn++) {
    if (Date.now() >= deadline) throw new Error('AGENT_BUDGET_EXHAUSTED');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model, input, tools, parallel_tool_calls: false,
        max_output_tokens: 1800, store: false }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
    const body = await response.json() as { model: string; output: Array<{ type: string; name: string; arguments: string; call_id: string; content?: Array<{ text: string }> }> };
    actualModel = body.model;
    input.push(...body.output);
    const calls = body.output.filter(o => o.type === 'function_call');
    if (!calls.length) {
      const decision = z.object({ action: z.enum(['replace', 'exclude']), candidateId: z.string().nullable(), reason: z.string().min(1).max(2000) }).strict()
        .parse(JSON.parse(body.output.filter(o => o.type === 'message').flatMap(o => o.content?.map(c => c.text) ?? []).join('')));
      const candidate = decision.candidateId ? analyzed.get(decision.candidateId) : null;
      if (!listed || (decision.action === 'replace' && (!candidate?.checks_passed ||
        candidate.evidence.status !== 'ready' || !compared.has(candidate.acquisition_id))) ||
        (decision.action === 'exclude' && decision.candidateId !== null)) throw new Error('UNSUPPORTED_PROPOSAL');
      return proposalSchema.parse({ action: decision.action, reason: decision.reason, candidate: candidate ?? null,
        model: actualModel, tool_calls: trace.length, trace });
    }
    for (const call of calls) {
      if (trace.length >= 10) throw new Error('AGENT_BUDGET_EXHAUSTED');
      const args = argsSchema.parse(JSON.parse(call.arguments));
      let output: unknown;
      if (call.name === 'list_alternates' && args.subjectId === original.subject_id) {
        listed = true;
        output = entries.filter(e => e.subject_id === original.subject_id && e.role === 'alternate');
      } else if (call.name === 'analyze_scan') {
        const entry = entries.find(e => e.acquisition_id === args.acquisitionId && e.subject_id === original.subject_id);
        if (!entry) throw new Error('INVALID_TOOL_ARGUMENT');
        const result = resultSchema.parse(await options.analyze(entry.acquisition_id, Math.max(1, deadline - Date.now())));
        if (result.input_sha256 !== entry.sha256) throw new Error('INPUT_MISMATCH');
        analyzed.set(entry.acquisition_id, result); output = result;
      } else if (call.name === 'compare_acquisitions' && args.originalId === original.acquisition_id) {
        const alternate = entries.find(e => e.acquisition_id === args.alternateId && e.role === 'alternate');
        const compatible = !!alternate && alternate.subject_id === original.subject_id && alternate.modality === original.modality && alternate.protocol_id === original.protocol_id;
        if (compatible) compared.add(alternate!.acquisition_id);
        output = { compatible, originalId: original.acquisition_id, alternateId: args.alternateId,
          subject: alternate?.subject_id ?? null, modality: alternate?.modality ?? null, protocol_id: alternate?.protocol_id ?? null,
          input_sha256: alternate?.sha256 ?? null };
      } else if (call.name === 'get_evidence') {
        const result = [...analyzed.values()].find(r => r.evidence.status === 'ready' && r.evidence.artifact_id === args.artifactId);
        if (!result || result.evidence.status !== 'ready') throw new Error('INVALID_TOOL_ARGUMENT');
        const bytes = readFileSync(join(options.evidenceDir, `${args.artifactId}.png`));
        if (createHash('sha256').update(bytes).digest('hex') !== args.artifactId) throw new Error('INVALID_EVIDENCE');
        output = result.evidence;
      } else throw new Error('INVALID_TOOL_ARGUMENT');
      trace.push({ tool: call.name as Proposal['trace'][number]['tool'], arguments: args, output });
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
    }
  }
  throw new Error('AGENT_BUDGET_EXHAUSTED');
}
