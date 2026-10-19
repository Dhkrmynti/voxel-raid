// Local API server. Vite proxies /api here (see vite.config.js).
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.API_PORT || 8787);
serve({ fetch: createApp().fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`API ready on http://127.0.0.1:${info.port}`);
});
