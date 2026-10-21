import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Finto PostgREST: solo le operazioni usate da server/store.js sulla tabella AAA3_Quiz_sessions.
function fakeSupabase() {
  const rows = new Map();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/rest/v1/AAA3_Quiz_sessions'); assert.equal(req.headers.apikey, 'sb_secret_test');
    const id = url.searchParams.get('id')?.replace('eq.', '');
    if (req.method === 'POST') rows.set(JSON.parse(raw).id, JSON.parse(raw));
    if (req.method === 'PATCH' && rows.has(id)) Object.assign(rows.get(id), JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'GET' ? JSON.stringify(rows.has(id) ? [{ quiz: rows.get(id).quiz }] : []) : '');
  });
  return { server, rows };
}
function fakeAI() {
  return createServer(async (req, res) => {
    for await (const _ of req);
    const questions = Array.from({ length: 10 }, (_, i) => ({ type: 'multiple', concept: `Concetto ${i}`, prompt: `Domanda ${i}?`, code: '',
      options: ['Corretta', 'Errata uno', 'Errata due', 'Errata tre'], correctIndex: 0, solution: 'Corretta',
      explanation: 'Questa scelta esprime il concetto. Le altre non lo rispettano.', rubric: 'Concetto.', review: `Ripassa il concetto ${i}.` }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ technical: false, questions }) }, finish_reason: 'stop' }] }));
  });
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }

test('HTTP: il quiz in corso sopravvive al riavvio del server grazie all\'archivio', { timeout: 20000 }, async t => {
  const supabase = fakeSupabase(), ai = fakeAI();
  const supabasePort = await listen(supabase.server), aiPort = await listen(ai);
  t.after(() => { for (const s of [supabase.server, ai]) { s.closeAllConnections(); s.close(); } });
  const reservation = createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, PORT: String(port), AI_PROVIDER: 'compatible', AI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`, AI_API_KEY: 'test-only', AI_MODEL: 'test-model',
    SUPABASE_URL: `http://127.0.0.1:${supabasePort}`, SUPABASE_SECRET_KEY: 'sb_secret_test' };
  const launch = async () => {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
    let output = '';
    await new Promise((resolve, reject) => {
      child.once('exit', () => reject(new Error('Server terminato prima dell’avvio')));
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Provider:')) resolve(); });
    });
    assert.match(output, /Sessioni: supabase\./);
    return child;
  };
  const base = `http://127.0.0.1:${port}`;
  let child = await launch();
  const start = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ topic: 'La fotosintesi', type: 'multiple', difficulty: 'media', size: 10 }) });
  const cookie = start.headers.get('set-cookie').split(';')[0], first = (await start.json()).question;
  const headers = { 'Content-Type': 'application/json', Origin: base, Cookie: cookie };
  const answer = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ questionId: 1, answer: first.options.indexOf('Corretta') }) });
  assert.equal(answer.status, 200);
  assert.equal(supabase.rows.size, 1); assert.equal([...supabase.rows.keys()][0].includes(cookie.split('=')[1]), false);
  // Riavvio, come dopo un deploy o una sospensione di Render: la memoria del server si svuota.
  const exited = once(child, 'exit'); child.kill(); await exited;
  child = await launch();
  const resumed = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
  assert.equal(resumed.quiz.question.id, 2); assert.equal(resumed.quiz.lastResult.score, 1);
  const next = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ questionId: 2, answer: resumed.quiz.question.options.indexOf('Corretta') }) });
  assert.equal(next.status, 200); assert.equal((await next.json()).result.score, 1);
  assert.equal([...supabase.rows.values()][0].quiz.answers.length, 2);
  const unknown = await fetch(`${base}/api/answer`, { method: 'POST', headers: { ...headers, Cookie: `quiz_session=${'b'.repeat(64)}` }, body: JSON.stringify({ questionId: 1, answer: 0 }) });
  assert.equal(unknown.status, 404);
});
