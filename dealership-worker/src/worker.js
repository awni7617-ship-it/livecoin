/*
  Forecourt — Cloudflare Worker entry point.

  Static files (index.html) are served from ./public by the assets binding.
  Anything that is not a static file lands here, which in practice means
  /api/plate. This is the same lookup the Pages Function did; a Worker is
  used instead because Cloudflare's drag-and-drop upload cannot run server
  code, and a Worker can be deployed from the command line without Git.
*/

import { handlePlate } from './plate.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/plate') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handlePlate(request, env);
    }

    // Everything else is the app itself.
    return env.ASSETS.fetch(request);
  },
};
