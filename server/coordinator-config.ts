import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Freestyle } from 'freestyle';
import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';
import { hash, MAX_PREVIEW_BYTES, siteId } from '../study/protocol.ts';
import { Coordinator } from './coordinator.ts';

const configSchema = z.object({
  sites: z.array(z.object({
    siteId, vmId: z.string().regex(/^vm-[a-zA-Z0-9]+$/),
    agentId: z.string().min(1), agentName: z.string().min(1),
    relayAgentToken: z.string().min(1),
    relayBaseUrl: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
    }),
  }).strict()).min(1).max(3),
}).strict();

/** Opt-in; the credential-free HTTP bootstrap remains usable without this file. */
export function configuredCoordinator(): Coordinator | undefined {
  if (!process.env.COORDINATOR_CONFIG) return;
  if (!process.env.TERSE_API_KEY || !process.env.TERSE_ACTOR_URL || !process.env.FREESTYLE_API_KEY) {
    throw new Error('COORDINATOR_CREDENTIALS_REQUIRED');
  }
  // Do not let schema errors print the private config/token values.
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(readFileSync(process.env.COORDINATOR_CONFIG, 'utf8'))); }
  catch { throw new Error('INVALID_COORDINATOR_CONFIG'); }
  const freestyle = new Freestyle();
  return new Coordinator(config.sites.map(site => {
    const vm = freestyle.vms.ref(site.vmId);
    return { siteId: site.siteId, agentId: site.agentId, agentName: site.agentName,
      relay: new RelaycastMessagingClient({ agentToken: site.relayAgentToken, baseUrl: site.relayBaseUrl }),
      async ensureReady() {
        if ((await vm.data()).state !== 'running') await vm.start();
        const health = await vm.linuxUser('root').exec({ command: 'systemctl is-active --quiet allot-site', timeoutMs: 10_000 });
        if (health.statusCode !== 0) throw new Error('SITE_RUNNER_NOT_READY');
      },
      async readEvidence(artifactId: string) {
        hash.parse(artifactId);
        // Never accept a path from a message. Bound the read itself, not only its result.
        return vm.fs.readFile(`/srv/allot/data/evidence/${artifactId}.png`, {
          length: MAX_PREVIEW_BYTES + 1, signal: AbortSignal.timeout(15_000),
        });
      },
    };
  }));
}
