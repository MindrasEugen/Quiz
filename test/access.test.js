import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const code = 'codice-di-prova';
const host = 'quiz.example.test';

async function freePort() {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const { port } = reservation.address(); await new Promise(resolve => reservation.close(resolve));
  return port;
}

function launch(t, port, env) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), AI_PROVIDER: 'compatible', AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_API_KEY: 'test-only-not-a-real-key', AI_MODEL: 'test-model', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  return child;
}

// fetch non permette di cambiare l'header Host: si usa node:http per simulare il dominio pubblico.
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
const login = (port, value) => call(port, '/accesso', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ codice: value }).toString() });

test('Pubblicazione: senza ACCESS_CODE il server non parte', { timeout: 10000 }, async t => {
  const child = launch(t, await freePort(), { PUBLIC_HOST: host, ACCESS_CODE: '' });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 1);
});

test('Pubblicazione: codice di accesso, cookie e limite dei tentativi', { timeout: 15000 }, async t => {
  const port = await freePort();
  const child = launch(t, port, { PUBLIC_HOST: host, ACCESS_CODE: code });
  await new Promise((resolve, reject) => {
    child.once('exit', () => reject(new Error('Server terminato prima dell’avvio')));
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Q.U.I.Z. Maker')) resolve(); });
  });

  assert.equal((await call(port, '/health', { headers: { Host: 'altro.example' } })).status, 200);
  assert.equal((await call(port, '/', { headers: { Host: 'altro.example' } })).status, 403);
  const page = await call(port, '/');
  assert.equal(page.status, 200); assert.match(page.text, /Inserisci il codice di accesso/); assert.doesNotMatch(page.text, /app\.js/);
  assert.equal((await call(port, '/style.css')).status, 200);
  assert.equal((await call(port, '/app.js')).status, 401);
  assert.equal((await call(port, '/api/status')).status, 401);

  const wrong = await login(port, 'sbagliato');
  assert.equal(wrong.status, 401); assert.match(wrong.text, /Codice non corretto/); assert.equal(wrong.headers['set-cookie'], undefined);
  const ok = await login(port, code);
  assert.equal(ok.status, 303);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.equal(cookie.includes(code), false);
  const access = cookie.split(';')[0];

  assert.match((await call(port, '/', { headers: { Cookie: access } })).text, /app\.js/);
  const status = await call(port, '/api/status', { headers: { Cookie: access } });
  assert.equal(status.status, 200);
  // L'origine HTTPS del dominio pubblico è accettata (qui la configurazione non valida dà 400, non 403).
  const start = await call(port, '/api/start', { method: 'POST', headers: { Cookie: access, Origin: `https://${host}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(start.status, 400);
  assert.equal((await call(port, '/api/status', { headers: { Cookie: 'quiz_access=' + '0'.repeat(64) } })).status, 401);

  for (let i = 0; i < 9; i++) assert.equal((await login(port, `errato-${i}`)).status, 401);
  const locked = await login(port, code);
  assert.equal(locked.status, 429); assert.equal(locked.headers['set-cookie'], undefined);
});
