import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';
import { SiteRunner, type SiteConfig } from './runner.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SiteConfig & {
  relayBaseUrl: string;
  relayAgentToken: string;
};
const relay = new RelaycastMessagingClient({ agentToken: config.relayAgentToken, baseUrl: config.relayBaseUrl });
const runner = new SiteRunner(config, relay);
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
try {
  while (!stopping) {
    try {
      await runner.cycle();
    } catch {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), code: 'SITE_CYCLE_RETRY' }));
    }
    if (!stopping) await setTimeout(1000);
  }
} finally { runner.close(); }
