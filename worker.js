/**
 * Rocket Arena — optional signalling relay (Cloudflare Worker).
 *
 * The game plays peer to peer over WebRTC and does not need this. Deploy it
 * only if you want four-letter room codes instead of copying invite blobs by
 * hand. It stores one offer and one answer per room for a few minutes and
 * never sees a byte of gameplay traffic — once the peers connect, everything
 * flows directly between them.
 *
 * Deploy:
 *   npx wrangler deploy worker.js --name rocket-arena-relay --compatibility-date 2024-01-01
 * then paste the worker URL into the game's Settings → Online → Relay URL.
 *
 * Rooms live in memory, so a room only works while both players are talking to
 * the same edge instance — fine for a quick match. For something sturdier,
 * bind a KV namespace as ROOMS and this will use it automatically.
 */

const TTL_MS = 10 * 60 * 1000;
const mem = new Map();
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const code = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alikes
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...CORS } });

async function getRoom(env, room) {
  if (env && env.ROOMS) {
    const v = await env.ROOMS.get('room:' + room, 'json');
    return v || null;
  }
  const v = mem.get(room);
  if (!v) return null;
  if (Date.now() - v.at > TTL_MS) { mem.delete(room); return null; }
  return v;
}
async function putRoom(env, room, val) {
  val.at = Date.now();
  if (env && env.ROOMS) return env.ROOMS.put('room:' + room, JSON.stringify(val), { expirationTtl: 600 });
  mem.set(room, val);
  if (mem.size > 500) for (const [k, v] of mem) if (Date.now() - v.at > TTL_MS) mem.delete(k);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // host publishes an offer and gets a room code back
    if (url.pathname === '/new' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.offer || body.offer.length > 20000) return json({ error: 'bad offer' }, 400);
      let room = code();
      for (let i = 0; i < 5 && await getRoom(env, room); i++) room = code();
      await putRoom(env, room, { offer: body.offer, answer: null });
      return json({ room });
    }
    // guest fetches the offer for a room
    if (url.pathname === '/offer') {
      const r = await getRoom(env, (url.searchParams.get('room') || '').toUpperCase());
      return r ? json({ offer: r.offer }) : json({ error: 'no room' }, 404);
    }
    // guest posts its answer
    if (url.pathname === '/answer' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const room = (body.room || '').toUpperCase();
      const r = await getRoom(env, room);
      if (!r) return json({ error: 'no room' }, 404);
      if (!body.answer || body.answer.length > 20000) return json({ error: 'bad answer' }, 400);
      r.answer = body.answer;
      await putRoom(env, room, r);
      return json({ ok: true });
    }
    // host polls for the answer
    if (url.pathname === '/answer') {
      const r = await getRoom(env, (url.searchParams.get('room') || '').toUpperCase());
      return r ? json({ answer: r.answer || null }) : json({ error: 'no room' }, 404);
    }
    return json({ ok: true, service: 'rocket-arena-relay' });
  }
};
