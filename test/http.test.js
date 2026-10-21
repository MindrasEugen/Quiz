import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('HTTP: quiz completo con provider simulato, cookie, ripresa e protezione origine', { timeout: 20000 }, async t => {
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(request.model, 'test-model');
    if (JSON.parse(request.messages[1].content).text) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'multiple', topic: 'La fotosintesi', difficulty: null, size: 10 }) }, finish_reason: 'stop' }] }));
    }
    const generated = { technical: false, questions: Array.from({ length: 10 }, (_, i) => ({
      type: 'multiple', concept: `Concetto ${i}`, prompt: `Domanda nuova ${i}?`, code: '',
      options: ['Corretta', 'Errata uno', 'Errata due', 'Errata tre'], correctIndex: 0,
      solution: 'SEGRETO_SOLUZIONE', explanation: 'Questa scelta esprime il concetto. Le altre non lo rispettano.',
      rubric: 'SEGRETO_RUBRICA', optionFeedback: ['', 'SEGRETO_FEEDBACK uno', 'SEGRETO_FEEDBACK due', 'SEGRETO_FEEDBACK tre'], review: `Ripassa con un esempio il concetto ${i}.`,
    })) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: 'stop' }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  // Porta effimera riservata prima di avviare il processo dell'app.
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), AI_PROVIDER: 'compatible', AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_API_KEY: 'test-only-not-a-real-key', AI_MODEL: 'test-model' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error('Server terminato prima dell’avvio')));
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Q.U.I.Z. Maker')) resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(base)).text(); assert.match(html, /Q\.U\.I\.Z\. Maker/);
  const css = await fetch(`${base}/style.css`); assert.equal(css.status, 200);
  const script = await fetch(`${base}/app.js`); assert.equal(script.status, 200);
  const status = await (await fetch(`${base}/api/status`)).json(); assert.equal(status.configured, true);
  const post = (path, data) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(data) });
  const parse = await post('parse', { text: '10 domande a crocette sulla fotosintesi' });
  assert.equal(parse.status, 200); assert.equal(parse.headers.get('set-cookie'), null);
  assert.deepEqual((await parse.json()).config, { type: 'multiple', topic: 'La fotosintesi', difficulty: null, size: 10 });
  assert.equal((await post('parse', { text: 'ancora' })).status, 429);
  assert.equal((await post('parse', { text: ' ' })).status, 400);
  const badConfig = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ topic: 'La fotosintesi' }) });
  assert.equal(badConfig.status, 400); assert.equal(badConfig.headers.get('set-cookie'), null);
  const invalid = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' });
  assert.equal(invalid.status, 403);
  const start = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ topic: 'La fotosintesi', type: 'multiple', difficulty: 'media', size: 10 }) });
  assert.equal(start.status, 200);
  const cookie = start.headers.get('set-cookie').split(';')[0]; assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  const initial = await start.json(); assert.equal(initial.question.id, 1);
  assert.equal(JSON.stringify(initial).includes('SEGRETO'), false); assert.equal('correctIndex' in initial.question, false);
  const headers = { 'Content-Type': 'application/json', Origin: base, Cookie: cookie };
  let result, current = initial.question;
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ questionId: i + 1, answer: current.options.indexOf('Corretta') }) });
    assert.equal(response.status, 200); result = await response.json(); assert.equal(result.result.score, 1);
    current = result.question;
    if (i === 0) {
      const statusResponse = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
      // Il cookie viene rinnovato a ogni uso: scade per inattività, non dalla creazione.
      assert.equal(statusResponse.headers.get('set-cookie').split(';')[0], cookie);
      const resumed = await statusResponse.json();
      assert.equal(resumed.quiz.question.id, 2); assert.equal(resumed.quiz.lastResult.score, 1);
      const duplicate = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ questionId: 1, answer: 0 }) });
      assert.equal(duplicate.status, 409);
    }
  }
  assert.equal(result.summary.points, 10); assert.equal(result.summary.grade, 10); assert.equal(result.question, null);
  const resumed = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
  assert.equal(resumed.quiz.summary.level, 'Ottimo');
  assert.equal(JSON.stringify(resumed).includes('SEGRETO_RUBRICA'), false);
});
