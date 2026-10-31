import { createAppServer } from './app.ts';
import { configuredCoordinator } from './coordinator-config.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const coordinator = configuredCoordinator();
const stopping = new AbortController();
let worker: Promise<void> = Promise.resolve();
const server = createAppServer();
server.on('error', () => {
  console.error(JSON.stringify({ code: 'HTTP_SERVER_ERROR' }));
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ code: 'HTTP_LISTENING', port }));
  if (coordinator) worker = coordinator.run(stopping.signal);
});

function shutdown() {
  console.log(JSON.stringify({ code: 'HTTP_STOPPING' }));
  stopping.abort();
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => { void worker.finally(() => clearTimeout(deadline)); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
