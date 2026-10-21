import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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
const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, ...lanAddresses.map(a => `${a}:${port}`)];
const accessCode = lan ? Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[randomInt(31)]).join('') : '';
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const sameCode = value => typeof value === 'string' && value.length === accessCode.length && timingSafeEqual(Buffer.from(value), Buffer.from(accessCode));
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
    if (!hosts.includes(req.headers.host)) return send(403, { error: 'Host non consentito.' });
    const cookies = req.headers.cookie?.split(';').map(s => s.trim()) || [];
    if (lan && !loopback(req.socket.remoteAddress)) {
      // Il codice arriva una volta nell'indirizzo, poi resta in un cookie HttpOnly.
      if (req.method === 'GET' && path === '/' && sameCode(url.searchParams.get('codice'))) {
        res.writeHead(303, { Location: '/', 'Set-Cookie': `quiz_access=${accessCode}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl / 1000}` }); res.end(); return;
      }
      if (!sameCode(cookies.find(s => s.startsWith('quiz_access='))?.slice(12))) return send(401, { error: 'Codice di accesso mancante: apri l’indirizzo completo mostrato nel terminale.' });
    }
    if (req.method === 'GET' && files.has(path)) {
      const [file, mime] = files.get(path);
      const content = await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(content); return;
    }
    if (!path.startsWith('/api/')) return send(404, { error: 'Pagina non trovata.' });
    // Host controllato sopra (DNS rebinding); qui la protezione dalle richieste cross-origin.
    if (req.method === 'POST' && (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json'))) {
      return send(403, { error: 'Origine della richiesta non consentita.' });
    }
    const cookie = cookies.find(s => s.startsWith('quiz_session='))?.slice(13);
    let entry = cookie ? sessions.get(cookie) : undefined;
    if (entry && Date.now() - entry.touched > ttl) { sessions.delete(cookie); entry = undefined; }
    // Il cookie scade dopo quattro ore di inattività, come la sessione sul server: va rinnovato a ogni uso.
    const setCookie = token => res.setHeader('Set-Cookie', `quiz_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}`);
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
server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Q.U.I.Z. Maker → http://localhost:${port}`);
  for (const address of lanAddresses) console.log(`Dalla rete locale → http://${address}:${port}/?codice=${accessCode}`);
  console.log(`Provider: ${provider.name}. ${provider.configured ? 'Configurazione presente.' : 'Inserisci la chiave nel file .env per iniziare.'}`);
});
