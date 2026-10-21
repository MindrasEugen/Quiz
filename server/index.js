import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createProvider } from './providers.js';
import { createQuizService, publicQuestion, summarize, validateConfig, validateDescription, QuizError } from './quiz.js';

const provider = createProvider();
const service = createQuizService(provider);
const sessions = new Map();
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const port = Number(process.env.PORT || 3000);
const ttl = 4 * 60 * 60 * 1000;
let lastParse = 0;
// Modalità rete (--lan): raggiungibile da altri dispositivi della rete locale, solo con codice di accesso.
const lan = process.argv.includes('--lan');
const lanAddresses = lan ? Object.values(networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address) : [];
// Pubblicazione (es. Render, che imposta RENDER_EXTERNAL_HOSTNAME): solo HTTPS e codice di accesso obbligatorio, scelto in ACCESS_CODE.
const publicHost = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.PUBLIC_HOST || '';
const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, ...lanAddresses.map(a => `${a}:${port}`), ...(publicHost ? [publicHost] : [])];
const accessCode = process.env.ACCESS_CODE?.trim() || (lan ? Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[randomInt(31)]).join('') : '');
if (publicHost && accessCode.length < 8) {
  console.error('Server pubblico: imposta ACCESS_CODE (almeno 8 caratteri) per proteggere il credito AI.');
  process.exit(1);
}
const secure = publicHost ? '; Secure' : '';
// Il cookie contiene un'impronta del codice, non il codice: cambiando ACCESS_CODE tutti gli accessi scadono.
const accessToken = createHmac('sha256', accessCode).update('quiz_access').digest();
const digest = value => createHash('sha256').update(String(value)).digest();
const sameCode = value => typeof value === 'string' && timingSafeEqual(digest(value), digest(accessCode));
const validToken = value => /^[0-9a-f]{64}$/.test(value || '') && timingSafeEqual(Buffer.from(value, 'hex'), accessToken);
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const accessCookie = `quiz_access=${accessToken.toString('hex')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 3600}${secure}`;
const failedLogins = [];
const loginPage = message => `<!doctype html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f6f5f0"><title>Q.U.I.Z. Maker — Accesso</title><link rel="stylesheet" href="/style.css"></head><body><header class="topbar"><span class="brand"><span class="brand-icon">Q<span>↗</span></span> Q.U.I.Z. <span class="brand-light">Maker</span></span></header><main><section class="panel"><form class="panel-body" method="post" action="/accesso"><div class="section-heading"><div><h2>Inserisci il codice di accesso</h2><p>Serve una sola volta su questo dispositivo.</p></div></div>${message ? `<div class="error login-error" role="alert">${message}</div>` : ''}<label class="input-label" for="codice">Codice</label><div class="describe-row"><input class="topic-input" id="codice" name="codice" type="password" autocomplete="current-password" required maxlength="200" autofocus><button class="primary" type="submit">Entra →</button></div></form></section></main></body></html>`;
setInterval(() => { for (const [id, session] of sessions) if (Date.now() - session.touched > ttl) sessions.delete(id); }, 60_000).unref();

async function body(req) {
  let chunks = [], length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16000) throw new QuizError('Richiesta troppo grande.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new QuizError('Richiesta JSON non valida.'); }
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    // Controllo di funzionamento per Render e per un eventuale cron job: non rivela nulla e non richiede il codice.
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
    if (!hosts.includes(req.headers.host)) return send(403, { error: 'Host non consentito.' });
    const sameOrigin = [`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin);
    const cookies = req.headers.cookie?.split(';').map(s => s.trim()) || [];
    if (accessCode && (publicHost || !loopback(req.socket.remoteAddress)) && !validToken(cookies.find(s => s.startsWith('quiz_access='))?.slice(12))) {
      const html = (status, message, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(loginPage(message)); };
      const granted = () => { res.writeHead(303, { Location: '/', 'Set-Cookie': accessCookie }); res.end(); };
      if (req.method === 'GET' && path === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(await readFile(fileURLToPath(new URL('../public/style.css', import.meta.url)))); return;
      }
      // Massimo 10 codici errati ogni 15 minuti, per tutto il server: impedisce di indovinare il codice per tentativi.
      while (failedLogins.length && Date.now() - failedLogins[0] > 15 * 60_000) failedLogins.shift();
      const locked = failedLogins.length >= 10;
      const tryCode = code => {
        if (locked) return html(429, 'Troppi tentativi errati. Riprova tra qualche minuto.');
        if (sameCode(code)) return granted();
        failedLogins.push(Date.now());
        return html(401, 'Codice non corretto.');
      };
      // Link con il codice (modalità rete locale), valido una volta: poi resta il cookie.
      if (req.method === 'GET' && path === '/' && url.searchParams.has('codice')) return tryCode(url.searchParams.get('codice'));
      if (req.method === 'POST' && path === '/accesso') {
        // Niente controllo Origin: con Referrer-Policy no-referrer i form inviano "null", e un accesso forzato richiederebbe comunque il codice.
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return html(403, 'Richiesta non consentita.');
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 1000) return html(413, 'Richiesta troppo grande.'); }
        return tryCode(new URLSearchParams(raw).get('codice')?.trim() || '');
      }
      if (path.startsWith('/api/')) return send(401, { error: 'Accesso scaduto: ricarica la pagina e inserisci il codice.' });
      return html(path === '/' ? 200 : 401, '');
    }
    if (req.method === 'GET' && files.has(path)) {
      const [file, mime] = files.get(path);
      const content = await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(content); return;
    }
    if (!path.startsWith('/api/')) return send(404, { error: 'Pagina non trovata.' });
    // Host controllato sopra (DNS rebinding); qui la protezione dalle richieste cross-origin.
    if (req.method === 'POST' && (!sameOrigin || !req.headers['content-type']?.startsWith('application/json'))) {
      return send(403, { error: 'Origine della richiesta non consentita.' });
    }
    const cookie = cookies.find(s => s.startsWith('quiz_session='))?.slice(13);
    let entry = cookie ? sessions.get(cookie) : undefined;
    if (entry && Date.now() - entry.touched > ttl) { sessions.delete(cookie); entry = undefined; }
    // Il cookie scade dopo quattro ore di inattività, come la sessione sul server: va rinnovato a ogni uso.
    const setCookie = token => res.setHeader('Set-Cookie', `quiz_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}${secure}`);
    if (entry) setCookie(cookie);
    if (req.method === 'GET' && path === '/api/status') {
      if (entry) entry.touched = Date.now();
      return send(200, { configured: provider.configured, provider: provider.name,
        quiz: entry?.quiz ? { config: entry.quiz.config, question: publicQuestion(entry.quiz), lastResult: entry.quiz.answers.at(-1) || null,
          summary: entry.quiz.finished ? summarize(entry.quiz) : null } : null });
    }
    if (req.method !== 'POST') return send(404, { error: 'Operazione non trovata.' });
    const data = await body(req);
    if (path === '/api/parse') {
      // Non richiede sessione. Una analisi ogni 2 secondi limita il consumo di credito AI.
      validateDescription(data?.text);
      if (Date.now() - lastParse < 2000) throw new QuizError('Attendi un momento prima di analizzare di nuovo.', 429);
      lastParse = Date.now();
      return send(200, { config: await service.parse(data.text) });
    }
    if (path === '/api/start') {
      // Configurazione non valida: errore immediato, senza creare sessioni né attivare l'attesa tra generazioni.
      validateConfig(data);
      if (!entry) {
        if (sessions.size >= 100) throw new QuizError('Troppe sessioni aperte. Riprova più tardi.', 429);
        const token = randomBytes(32).toString('hex');
        entry = { touched: Date.now(), starting: false, quiz: null };
        sessions.set(token, entry);
        setCookie(token);
      }
      if (entry.starting || entry.quiz?.busy) throw new QuizError('Operazione già in corso.', 409);
      if (entry.lastStart && Date.now() - entry.lastStart < 5000) throw new QuizError('Attendi qualche secondo prima di rigenerare.', 429);
      entry.lastStart = Date.now(); entry.starting = true;
      try {
        entry.quiz = await service.start(data);
        entry.touched = Date.now();
        return send(200, { question: publicQuestion(entry.quiz) });
      } finally { entry.starting = false; }
    }
    if (!entry?.quiz) throw new QuizError('Sessione scaduta. Crea un nuovo quiz.', 404);
    entry.touched = Date.now();
    if (path === '/api/answer') return send(200, await service.answer(entry.quiz, data));
    if (path === '/api/stop') return send(200, { summary: service.stop(entry.quiz) });
    return send(404, { error: 'Operazione non trovata.' });
  } catch (error) { send(error.status || 502, { error: error.message || 'Operazione non riuscita. Riprova.', ...(error.field && { field: error.field }) }); }
});
server.requestTimeout = 150_000;
server.listen(port, lan || publicHost ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Q.U.I.Z. Maker → http://localhost:${port}`);
  for (const address of lanAddresses) console.log(`Dalla rete locale → http://${address}:${port}/?codice=${accessCode}`);
  console.log(`Provider: ${provider.name}. ${provider.configured ? 'Configurazione presente.' : 'Inserisci la chiave nel file .env per iniziare.'}`);
});
