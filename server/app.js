import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAccounts } from './accounts.js';
import { createApi, HttpError } from './api.js';
import { createHooks } from './hooks.js';
import { createAuth } from './auth.js';
import { createConnect } from './connect.js';
import { createPublic } from './public.js';
import { createTranscripts } from './transcripts.js';
import { createUploads } from './uploads.js';
import { safeFetch } from './net/safe-fetch.js';
import { FlowError } from './engine/errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ config, db, runtime, bot, sync, logger, fetchImpl, uploads = createUploads({ config, db, logger }), transcripts = createTranscripts({ config, db, logger }), accounts = createAccounts({ config, db, fetch: safeFetch, logger }), distDir = path.join(ROOT, 'dist') }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/hooks', createHooks({ db, runtime }).router); // public webhook addresses: before the dashboard's parser, with a body limit of their own
  app.use(express.json({ limit: config.requestBytes ?? 50 * 1024 * 1024 }));

  const auth = createAuth({ config, db, fetchImpl, log: (m) => logger.log(null, 'warn', m) });
  app.use(auth.router);
  const connect = createConnect({ config, db, auth, accounts, bot, runtime, logger });
  app.use(connect.router); // “Connect Twitch / TikTok” coming back from the platform: /auth/<provider>/callback
  app.get('/healthz', (_req, res) => res.json({ ok: true, botReady: Boolean(bot.ready) }));
  app.use('/s', createPublic({ config, db, runtime, bot, logger, auth }).router); // public pages: no dashboard session, own CSP
  app.use('/i', uploads.files); // uploaded pictures: public, read-only, no session
  app.use('/t', transcripts.files); // saved transcripts: public to anyone with the link, read-only, no session
  app.use('/api', createApi({ config, db, runtime, bot, sync, logger, auth, uploads, accounts, connect }));

  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/s/') || req.path.startsWith('/i/') || req.path.startsWith('/t/') || req.path.startsWith('/hooks/')) return next();
      res.set('Cache-Control', 'no-cache');
      return res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (_req, res) => res.status(503).type('text').send('The web UI has not been built yet. Run `npm run build` and restart.'));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

   
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof FlowError) return res.status(400).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.log(null, 'error', `Unhandled request error: ${err?.stack || err}`);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}
