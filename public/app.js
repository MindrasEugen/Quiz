const $ = selector => document.querySelector(selector);
const root = $('#workspace');
const labels = { multiple: 'Risposta multipla', free: 'Risposta libera', snippet: 'Snippet di codice', mix: 'Mix equilibrato' };
const fields = ['type', 'topic', 'difficulty', 'size'];
const titles = ['Question type', 'Unit', 'Intensity', 'siZe'];
let config = { type: '', topic: '', difficulty: '', size: null };
let step = 0, question = null, lastResult = null, selected = null, busy = false, configured = false, description = '';
const notConfigured = 'Inserisci la chiave API nel file .env e riavvia il server per generare il quiz.';
const outcome = score => score === 1 ? '✅ Corretta' : score === 0.5 ? '🟡 Parziale' : '❌ Errata';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = value => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value);
const button = (text, action, klass = 'primary') => `<button type="button" class="${klass}" data-action="${action}">${text}</button>`;
function error(message = '') { $('#error').hidden = !message; $('#error').textContent = message; }
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  let result;
  try { result = await response.json(); } catch { throw new Error('Il server non ha risposto correttamente. Riprova.'); }
  // field: passo Q.U.I.Z. da correggere, indicato dal server nei chiarimenti.
  if (!response.ok) throw Object.assign(new Error(result.error || 'Operazione non riuscita.'), { field: result.field });
  return result;
}
function focusHeading() { const heading = root.querySelector('h2'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
function setBusy(value) { busy = value; root.setAttribute('aria-busy', String(value)); root.querySelectorAll('button,input,textarea').forEach(e => { e.disabled = value; }); }
function valueLabel(key) {
  if (key === 'type') return labels[config.type];
  if (key === 'size') return config.size ? `${config.size} domande` : '';
  return config[key];
}
function choice(value, icon, title, description) {
  return `<button type="button" class="choice ${String(config[fields[step]]) === String(value) ? 'selected' : ''}" data-value="${escape(value)}" aria-pressed="${String(config[fields[step]]) === String(value)}"><span class="radio" aria-hidden="true"></span><span class="choice-icon" aria-hidden="true">${icon}</span><strong>${title}</strong><small>${description}</small></button>`;
}
function renderSetup() {
  question = null; selected = null;
  const steps = titles.map((t, i) => `${i ? '<span class="step-line"></span>' : ''}<span class="step ${i === step ? 'active' : i < step ? 'done' : ''}" ${i === step ? 'aria-current="step"' : ''}><span class="step-badge">${i < step ? '✓' : 'QUIZ'[i]}</span>${t}</span>`).join('');
  const headings = ['Che tipo di domande preferisci?', 'Su cosa vuoi metterti alla prova?', 'Quanto vuoi alzare l’asticella?', 'Quanto spazio dai alla curiosità?'];
  const subtitles = ['Scegli come allenarti. Al resto pensiamo noi.', 'Un argomento preciso rende il quiz più utile.', 'Scegli la difficoltà più adatta al tuo momento.', 'Scegli il numero di domande, poi inizia il tuo quiz.'];
  let content;
  if (step === 0) content = `<label class="input-label" for="describe">Descrivi il quiz che vuoi</label><div class="describe-row"><input class="topic-input" id="describe" maxlength="500" placeholder="Es. 10 domande facili a risposta multipla sugli array in JavaScript" value="${escape(description)}" autocomplete="off">${button('Analizza <span aria-hidden="true">↗</span>', 'parse', 'secondary')}</div><p class="divider-label">oppure scegli passo per passo</p><div class="choices" role="group" aria-label="Tipo di domanda">${choice('multiple', '☷', labels.multiple, 'Quattro opzioni.<br>Una risposta corretta.')}${choice('free', '✎', labels.free, 'Spiega quello che sai<br>in 1–3 frasi.')}${choice('snippet', '&lt;/&gt;', 'Snippet di codice', 'Leggi, completa<br>o correggi il codice.')}${choice('mix', '↗', labels.mix, 'Alterna i formati<br>e cambia prospettiva.')}</div>`;
  if (step === 1) content = `<label class="input-label" for="topic">Argomento del quiz</label><input class="topic-input" id="topic" maxlength="300" placeholder="Es. gli array in JavaScript" value="${escape(config.topic)}" autocomplete="off"><div class="examples">${['Array in JavaScript', 'La Rivoluzione francese', 'La fotosintesi'].map(t => `<button class="example" type="button" data-topic="${t}">${t}</button>`).join('')}</div><p class="hint">Gli snippet sono disponibili per argomenti di programmazione.</p>`;
  if (step === 2) content = `<div class="choices" role="group" aria-label="Difficoltà">${choice('facile', 'Ⅰ', 'Facile', 'Le basi, con calma.<br>Costruisci fiducia.')}${choice('media', 'Ⅱ', 'Media', 'Collega i concetti.<br>Fai un passo in più.')}${choice('difficile', 'Ⅲ', 'Difficile', 'Dettagli e casi limite.<br>Accetta la sfida.')}${choice('progressiva', '↗', 'Progressiva', 'Parti dalle basi.<br>Cresci domanda dopo domanda.')}</div>`;
  if (step === 3) content = `<div class="choices" role="group" aria-label="Numero di domande">${choice(10, '10', '10 domande', 'Un ripasso mirato.')}${choice(15, '15', '15 domande', 'Il giusto approfondimento.')}${choice(20, '20', '20 domande', 'Una verifica completa.')}</div>`;
  const table = `<table class="config-table"><caption class="sr-only">Stato della configurazione Q.U.I.Z.</caption><tbody>${fields.map((key, i) => `<tr><td aria-label="${config[key] ? 'Soddisfatto' : 'Mancante'}">${config[key] ? '✅' : '❌'}</td><td>${'QUIZ'[i]}: ${titles[i]}</td><td>${escape(valueLabel(key) || 'Da scegliere')}</td></tr>`).join('')}</tbody></table>`;
  root.innerHTML = `<div class="panel"><div class="stepbar">${steps}</div><div class="panel-body"><div class="section-heading"><div><h2>${headings[step]}</h2><p>${subtitles[step]}</p></div><span class="step-count">${step + 1} di 4</span></div>${content}${table}<div class="panel-actions">${step ? button('← Indietro', 'back', 'text-button') : '<span class="hint">✧ Ogni risposta è un’occasione per imparare.</span>'}${button(step === 3 ? 'Crea il mio quiz <span aria-hidden="true">↗</span>' : 'Continua <span aria-hidden="true">→</span>', 'next')}</div></div></div>`;
}
function updateConfigTable() {
  root.querySelectorAll('.config-table tbody tr').forEach((row, i) => {
    const present = Boolean(config[fields[i]]);
    row.cells[0].textContent = present ? '✅' : '❌';
    row.cells[0].setAttribute('aria-label', present ? 'Soddisfatto' : 'Mancante');
    row.cells[2].textContent = valueLabel(fields[i]) || 'Da scegliere';
  });
}
function richText(value) {
  // Nessun HTML del modello viene eseguito. Renderizza solo i blocchi di codice delimitati.
  return String(value).split(/```(?:[a-zA-Z0-9+#.-]+)?\n?([\s\S]*?)```/g).map((part, i) => i % 2 ? `<pre><code>${escape(part.trim())}</code></pre>` : `<span>${escape(part)}</span>`).join('');
}
function feedback() {
  if (!lastResult) return '';
  const { score, solution, explanation } = lastResult;
  return `<section class="feedback ${score === 1 ? '' : score === 0.5 ? 'partial' : 'wrong'}" aria-label="Esito della risposta"><h2>Esito: ${outcome(score)} (${fmt(score)}/1)</h2><p><strong>Risposta corretta:</strong> ${richText(solution)}</p><p><strong>Spiegazione:</strong> ${richText(explanation)}</p></section>`;
}
function renderQuestion() {
  selected = null;
  root.innerHTML = `${feedback()}<section class="panel"><div class="progress-heading"><span>${escape(config.topic)}</span><span>${escape(config.difficulty)} · ${question.total} domande</span></div><div class="progress-track"><progress max="${question.total}" value="${question.id - 1}" aria-label="Domande completate"></progress></div><div class="panel-body"><span class="question-type">${labels[question.type]}</span><h2 class="question-prompt"><span class="mini-label">Domanda ${question.id}/${question.total}</span><br>${escape(question.prompt)}</h2>${question.code ? `<pre><code>${escape(question.code)}</code></pre>` : ''}${question.type === 'multiple' ? `<div class="answer-options" role="group" aria-label="Opzioni di risposta">${question.options.map((o, i) => `<button type="button" class="answer-option" data-answer="${i}" aria-pressed="false"><span class="answer-letter">${'ABCD'[i]}</span><span>${escape(o)}</span></button>`).join('')}</div>` : `<label class="input-label" for="answer">La tua risposta${question.type === 'free' ? ' (1–3 frasi)' : ''}</label><textarea id="answer" maxlength="4000" placeholder="Scrivi qui quello che sai…"></textarea>`}<div class="panel-actions">${button('Non so', 'skip', 'text-button')}${button('Conferma risposta →', 'answer')}</div><div class="panel-actions"><span class="hint">La spiegazione arriva dopo ogni risposta.</span>${button('Interrompi quiz', 'stop', 'text-button')}</div></div></section>`;
  focusHeading();
}
function renderSummary(summary) {
  question = null;
  root.innerHTML = `${feedback()}<section class="panel"><div class="panel-body"><div class="summary-top"><div class="score-circle"><strong>${fmt(summary.percentage)}%</strong><small>${summary.level === 'Non valutato' ? 'Nessuna risposta' : 'Punteggio'}</small></div><div><span class="mini-label">IL TUO PERCORSO</span><h2>${escape(summary.level)}</h2><p>Punteggio totale: <strong>${fmt(summary.points)}/${summary.total}</strong> · Voto <strong>${fmt(summary.grade)}/10</strong></p><p>${summary.total} domande svolte su ${summary.planned} previste.</p></div></div>${summary.total ? `<table class="results"><caption class="sr-only">Risultati delle domande svolte</caption><thead><tr><th>#</th><th>Tipo</th><th>Esito</th><th>Punti</th></tr></thead><tbody>${summary.rows.map(r => `<tr><td>${r.number}</td><td>${labels[r.type]}</td><td>${outcome(r.score)}</td><td>${fmt(r.score)}</td></tr>`).join('')}</tbody></table>` : '<p>Il quiz è stato interrotto prima della prima risposta.</p>'}${summary.review.length ? `<h3 class="review-title">Da ripassare</h3><ul class="review-list">${summary.review.map(r => `<li>${r.questions.length ? `<strong>Domanda ${r.questions.join(', ')}:</strong> ` : ''}${escape(r.text)}</li>`).join('')}</ul>` : ''}<div class="panel-actions"><span class="hint">Un nuovo quiz sullo stesso argomento o su uno diverso?</span>${button('Nuovo quiz ↗', 'new')}</div></div></section>`;
  focusHeading();
}
async function startQuiz() {
  if (!configured) throw new Error(notConfigured);
  setBusy(true);
  root.innerHTML = '<div class="panel loading" role="status"><div class="spinner" aria-hidden="true"></div><h2>La curiosità prende forma.</h2><p>Sto preparando domande e spiegazioni sul tuo argomento.<br>Potrebbe volerci un minuto.</p></div>';
  try {
    const result = await api('start', config); question = result.question; lastResult = null; renderQuestion();
  } catch (e) {
    // Chiarimento richiesto dal modello: torna al passo da correggere, con il valore precedente modificabile.
    if (fields.includes(e.field)) step = fields.indexOf(e.field);
    renderSetup();
    if (e.field) (root.querySelector('#topic') || root.querySelector('.choice'))?.focus();
    throw e;
  } finally { setBusy(false); }
}
async function parseDescription() {
  if (!configured) throw new Error(notConfigured);
  if (!description.trim()) throw new Error('Descrivi il quiz in una frase, oppure scegli passo per passo.');
  setBusy(true);
  let parsed;
  try { parsed = (await api('parse', { text: description.trim() })).config; } finally { setBusy(false); }
  const found = fields.filter(key => parsed[key] !== null && parsed[key] !== undefined);
  if (!found.length) throw new Error('Non ho riconosciuto nessuna scelta: prova a riformulare o scegli passo per passo.');
  for (const key of found) config[key] = parsed[key];
  // Tutti e 4 gli elementi presenti: il quiz parte subito. Altrimenti si chiede il primo mancante (Q→U→I→Z).
  const missing = fields.findIndex(key => !config[key]);
  if (missing === -1) return startQuiz();
  step = missing; renderSetup(); focusHeading();
}
async function submitAnswer(skip = false) {
  const answer = skip ? 'non so' : question.type === 'multiple' ? selected : $('#answer').value.trim();
  if (answer === null || answer === '') throw new Error('Scegli o scrivi una risposta, oppure premi “Non so”.');
  setBusy(true);
  const confirm = root.querySelector('[data-action="answer"]'); confirm.textContent = 'Correzione in corso…';
  try {
    const result = await api('answer', { questionId: question.id, answer });
    lastResult = result.result; question = result.question;
    if (result.summary) renderSummary(result.summary); else renderQuestion();
  } finally { setBusy(false); if (confirm.isConnected) confirm.textContent = 'Conferma risposta →'; }
}
root.addEventListener('input', event => {
  if (event.target.id === 'topic') { config.topic = event.target.value; updateConfigTable(); }
  if (event.target.id === 'describe') description = event.target.value;
});
// Invio nella descrizione = Analizza; Invio nell'argomento = Continua.
root.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  const action = { describe: 'parse', topic: 'next' }[event.target.id];
  if (action) { event.preventDefault(); root.querySelector(`[data-action="${action}"]`)?.click(); }
});
root.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target || busy) return;
  error();
  try {
    if (target.dataset.value !== undefined) {
      config[fields[step]] = step === 3 ? Number(target.dataset.value) : target.dataset.value;
      root.querySelectorAll('.choice').forEach(e => { const selected = e === target; e.classList.toggle('selected', selected); e.setAttribute('aria-pressed', selected); });
      updateConfigTable();
      return;
    }
    if (target.dataset.topic) { config.topic = target.dataset.topic; $('#topic').value = config.topic; updateConfigTable(); $('#topic').focus(); return; }
    if (target.dataset.answer !== undefined) {
      selected = Number(target.dataset.answer);
      root.querySelectorAll('.answer-option').forEach(e => { e.classList.toggle('selected', e === target); e.setAttribute('aria-pressed', e === target); }); return;
    }
    switch (target.dataset.action) {
      case 'parse': await parseDescription(); break;
      case 'next':
        if (!config[fields[step]] || (step === 1 && !config.topic.trim())) throw new Error('Completa questa scelta prima di continuare.');
        if (step < 3) { step++; renderSetup(); focusHeading(); } else await startQuiz(); break;
      case 'back': step--; renderSetup(); focusHeading(); break;
      case 'answer': await submitAnswer(); break;
      case 'skip': await submitAnswer(true); break;
      case 'stop': {
        setBusy(true);
        try { const result = await api('stop', {}); lastResult = null; renderSummary(result.summary); }
        finally { setBusy(false); }
        break;
      }
      case 'new': step = 0; lastResult = null; renderSetup(); focusHeading(); break;
    }
  } catch (e) { error(e.message); $('#error').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
});

renderSetup();
try {
  const status = await api('status');
  configured = status.configured;
  if (!configured) { $('#notice').textContent = 'L’interfaccia è pronta. Per creare quiz, copia .env.example in .env, inserisci la chiave Mistral e riavvia il server. La chiave resta sul server.'; $('#notice').hidden = false; }
  if (status.quiz) {
    config = status.quiz.config; lastResult = status.quiz.lastResult; question = status.quiz.question;
    if (status.quiz.summary) renderSummary(status.quiz.summary); else renderQuestion();
  }
} catch { error('Connessione al server non disponibile. Ricarica la pagina dopo aver avviato pnpm start.'); }
