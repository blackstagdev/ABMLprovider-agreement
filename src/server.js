// Render web service entry: HTTP + in-process durable worker + periodic reconcile.
import http from 'node:http';
import { createApp } from './app.js';
import { log } from './log.js';
import { migrate } from './migrate.js';
import { buildServices } from './services.js';
import { startWorker } from './sync/jobs.js';

const s = await buildServices();
await migrate(s.db); // idempotent; also run as Render preDeployCommand

const server = http.createServer(createApp(s));
server.listen(s.cfg.port, '0.0.0.0', () => log.info('listening', { port: s.cfg.port }));

let stopWorker = () => {};
let timer = null;
if (s.cfg.sync.workerEnabled) {
  stopWorker = startWorker(s.jobs, s.handlers);
  const every = s.cfg.sync.reconcileIntervalMinutes * 60_000;
  const tick = () => s.jobs.enqueue('reconcile', {}, 'reconcile').catch((err) => log.error('enqueue reconcile failed', { err }));
  timer = setInterval(tick, every);
  setTimeout(tick, 30_000);
}

const shutdown = () => {
  log.info('shutting down');
  stopWorker();
  clearInterval(timer);
  server.close(() => s.db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
