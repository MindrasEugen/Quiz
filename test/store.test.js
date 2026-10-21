import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';

const quiz = { id: 'q1', config: { size: 10 }, questions: [{ prompt: 'Domanda?' }], answers: [], finished: false, busy: true };
const token = 'a'.repeat(64);

test('archivio in memoria: senza Supabase conserva il quiz senza i flag di lavoro e lo fa scadere', async () => {
  const store = createStore({}, fetch, 50);
  assert.equal(store.name, 'memoria');
  await store.save(token, quiz);
  const loaded = await store.load(token);
  assert.equal(loaded.questions[0].prompt, 'Domanda?'); assert.equal('busy' in loaded, false);
  loaded.answers.push({ score: 1 });
  assert.equal((await store.load(token)).answers.length, 0);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await store.load(token), null);
});

test('archivio Supabase: tabella AAA3_Quiz_sessions, id come impronta del cookie, chiave solo negli header', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), ...options });
    return new Response(options.method ? null : JSON.stringify([{ quiz: { id: 'q1' } }]), { status: options.method === 'POST' ? 201 : 200 });
  };
  const store = createStore({ SUPABASE_URL: 'https://esempio.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_prova' }, fetcher);
  assert.equal(store.name, 'supabase');
  await store.save(token, quiz);
  assert.deepEqual(await store.load(token), { id: 'q1' });
  await store.touch(token); await store.cleanup();
  assert.deepEqual(requests.map(r => r.method || 'GET'), ['POST', 'GET', 'PATCH', 'DELETE']);
  assert.ok(requests.every(r => r.url.startsWith('https://esempio.supabase.co/rest/v1/AAA3_Quiz_sessions?')));
  assert.ok(requests.every(r => !r.url.includes(token) && r.headers.apikey === 'sb_secret_prova' && !r.headers.Authorization));
  const saved = JSON.parse(requests[0].body);
  assert.match(saved.id, /^[0-9a-f]{64}$/); assert.notEqual(saved.id, token); assert.equal('busy' in saved.quiz, false);
  assert.match(requests[1].url, /id=eq\.[0-9a-f]{64}&touched_at=gt\./);
  assert.match(requests[3].url, /touched_at=lt\./);
});

test('archivio Supabase: errori HTTP segnalati e solo HTTPS', async () => {
  const store = createStore({ SUPABASE_URL: 'https://esempio.supabase.co', SUPABASE_SECRET_KEY: 'k' }, async () => new Response('{}', { status: 401 }));
  await assert.rejects(store.load(token), /errore \(401\)/);
  assert.throws(() => createStore({ SUPABASE_URL: 'http://esempio.supabase.co', SUPABASE_SECRET_KEY: 'k' }), /HTTPS/);
});
