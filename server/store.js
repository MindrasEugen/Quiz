import { createHash } from 'node:crypto';

// Contratto dell'archivio: load(token) => quiz | null, save(token, quiz), touch(token), cleanup().
// Con SUPABASE_URL e SUPABASE_SECRET_KEY i quiz in corso sopravvivono a riavvii e deploy; senza, restano in memoria.
// Nel database l'id è l'impronta SHA-256 del cookie: chi legge la tabella non può riusare le sessioni.
const TABLE = 'AAA3_Quiz_sessions';
const hash = token => createHash('sha256').update(token).digest('hex');
// Solo lo stato del quiz: i flag di lavoro in corso (busy) restano in memoria.
const snapshot = ({ id, config, questions, answers, finished }) => ({ id, config, questions, answers, finished });

export function createStore(env = process.env, fetcher = fetch, ttl = 4 * 60 * 60 * 1000) {
  const base = env.SUPABASE_URL?.trim(), key = env.SUPABASE_SECRET_KEY?.trim();
  if (!base || !key) {
    const memory = new Map();
    return {
      name: 'memoria',
      async load(token) { const row = memory.get(token); return row && Date.now() - row.touched <= ttl ? structuredClone(row.quiz) : null; },
      async save(token, quiz) { memory.set(token, { quiz: structuredClone(snapshot(quiz)), touched: Date.now() }); },
      async touch(token) { const row = memory.get(token); if (row) row.touched = Date.now(); },
      async cleanup() { for (const [token, row] of memory) if (Date.now() - row.touched > ttl) memory.delete(token); },
    };
  }
  const url = new URL(`rest/v1/${TABLE}`, base.endsWith('/') ? base : `${base}/`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Supabase deve usare HTTPS (HTTP consentito solo in locale).');
  }
  // Le chiavi segrete sb_secret_ vanno solo in apikey; la vecchia service_role (JWT) anche in Authorization.
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }) };
  const request = async (query, options = {}) => {
    const response = await fetcher(`${url}?${query}`, { redirect: 'error', signal: AbortSignal.timeout(10_000), ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok) throw new Error(`Supabase ha restituito un errore (${response.status}).`);
    return response;
  };
  const since = () => new Date(Date.now() - ttl).toISOString();
  return {
    name: 'supabase',
    async load(token) {
      const rows = await (await request(`select=quiz&id=eq.${hash(token)}&touched_at=gt.${encodeURIComponent(since())}`)).json();
      return Array.isArray(rows) && rows[0]?.quiz ? rows[0].quiz : null;
    },
    async save(token, quiz) {
      await request('on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: hash(token), quiz: snapshot(quiz), touched_at: new Date().toISOString() }) });
    },
    async touch(token) {
      await request(`id=eq.${hash(token)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ touched_at: new Date().toISOString() }) });
    },
    async cleanup() {
      await request(`touched_at=lt.${encodeURIComponent(since())}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },
  };
}
