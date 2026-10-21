import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuizService, publicQuestion, summarize, validateConfig, normalizeQuestion } from '../server/quiz.js';
import { createProvider } from '../server/providers.js';

const config = { type: 'multiple', topic: 'Array JavaScript', difficulty: 'media', size: 10 };
function generated(type = 'multiple') {
  return { technical: true, questions: Array.from({ length: 10 }, (_, i) => ({ type, concept: `Concetto ${i}`,
    prompt: `Quesito ${i}?`, code: type === 'snippet' ? 'const n = 1;' : '', options: type === 'multiple' ? ['Sì', 'No', 'Mai', 'Sempre'] : [],
    correctIndex: type === 'multiple' ? 0 : null, solution: 'Una soluzione', explanation: 'La soluzione verifica il concetto. Le altre alternative non lo rispettano.',
    rubric: 'Un punto per il concetto completo, mezzo per una parte.', review: `Prova un esempio del concetto ${i}.` })) };
}
// Le chiamate di verifica delle multiple sono registrate a parte: `calls` resta generazione + correzioni.
function makeService(data = generated(), fixes = []) {
  const calls = [], verifications = [];
  const provider = { async complete(request) {
    if (request.input?.task === 'verifica') { verifications.push(request); return { fixes }; }
    calls.push(request); return calls.length === 1 ? data : { score: 0.5, explanation: 'Hai espresso parte del concetto. Manca il caso limite.' };
  } };
  // Mescolamento neutro (nessuno scambio): posizioni corrette prevedibili nei test, 0,1,2,3,0...
  return { service: createQuizService(provider, n => n - 1), calls, verifications };
}
test('configurazione: rifiuta input incompleti o fuori dai pacchetti', () => {
  assert.throws(() => validateConfig({ ...config, size: 12 }));
  assert.throws(() => validateConfig({ ...config, topic: ' ' }));
  assert.throws(() => validateConfig({ ...config, type: 'essay' }));
  assert.deepEqual(validateConfig({ ...config, topic: ' Array JavaScript ' }), config);
});
test('la domanda pubblica non espone soluzione, rubrica o indici corretti', async () => {
  const { service } = makeService();
  const session = await service.start(config);
  assert.deepEqual(Object.keys(publicQuestion(session)).sort(), ['code', 'id', 'options', 'prompt', 'total', 'type']);
  assert.equal(session.questions[1].options[1], 'Sì');
  assert.notEqual(session.questions[0].correctIndex, session.questions[1].correctIndex);
});
test('posizione della risposta corretta casuale ma bilanciata tra A-D', async () => {
  const provider = { async complete() { return generated(); } };
  const sequences = new Set();
  for (let run = 0; run < 20; run++) {
    const session = await createQuizService(provider).start(config);
    const positions = session.questions.map(q => q.correctIndex);
    const counts = [0, 1, 2, 3].map(p => positions.filter(x => x === p).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    session.questions.forEach(q => assert.equal(q.options[q.correctIndex], 'Sì'));
    sequences.add(positions.join(''));
  }
  assert.ok(sequences.size > 1);
});
test('risposte multiple corrette localmente, no parziali, no doppi invii', async () => {
  const { service, calls } = makeService();
  const session = await service.start(config);
  const result = await service.answer(session, { questionId: 1, answer: 0 });
  assert.equal(result.result.score, 1); assert.equal(result.question.id, 2);
  await assert.rejects(service.answer(session, { questionId: 1, answer: 0 }), /già stata valutata/);
  assert.equal((await service.answer(session, { questionId: 2, answer: 0 })).result.score, 0);
  assert.equal(calls.length, 1); assert.equal(session.answers.length, 2);
});
test('non so vale zero per ogni formato senza spendere una chiamata AI', async () => {
  for (const type of ['multiple', 'free', 'snippet']) {
    const { service, calls } = makeService(generated(type));
    const session = await service.start({ ...config, type });
    const result = await service.answer(session, { questionId: 1, answer: 'Non so.' });
    assert.equal(result.result.score, 0); assert.ok(result.result.explanation); assert.equal(calls.length, 1);
  }
});
test('risposte libere ammettono mezzo punto e la rubrica viene inviata al provider', async () => {
  const { service, calls } = makeService(generated('free'));
  const session = await service.start({ ...config, type: 'free' });
  const result = await service.answer(session, { questionId: 1, answer: 'Un concetto parziale.' });
  assert.equal(result.result.score, 0.5); assert.equal(calls[1].input.studentAnswer, 'Un concetto parziale.');
  assert.ok(calls[1].input.rubric);
});
test('errori del provider non consumano una risposta né lasciano la sessione bloccata', async () => {
  let calls = 0;
  const service = createQuizService({ async complete() { if (++calls === 1) return generated('free'); throw new Error('offline'); } });
  const session = await service.start({ ...config, type: 'free' });
  await assert.rejects(service.answer(session, { questionId: 1, answer: 'Test' }), /offline/);
  assert.equal(session.answers.length, 0); assert.equal(session.busy, false);
});
test('impedisce invii concorrenti e interruzione durante la valutazione', async () => {
  let release, calls = 0;
  const service = createQuizService({ async complete() {
    if (++calls === 1) return generated('free');
    return new Promise(resolve => { release = resolve; });
  } });
  const session = await service.start({ ...config, type: 'free' });
  const pending = service.answer(session, { questionId: 1, answer: 'Risposta' });
  await assert.rejects(service.answer(session, { questionId: 1, answer: 'Altra' }), /in corso/);
  assert.throws(() => service.stop(session), /in corso/);
  release({ score: 1, explanation: 'Il concetto è corretto.' }); await pending;
  assert.equal(session.answers.length, 1);
});
test('interruzione: denominatore sulle domande svolte, voto arrotondato e ripasso collegato', async () => {
  const { service } = makeService(); const session = await service.start(config);
  await service.answer(session, { questionId: 1, answer: 0 });
  await service.answer(session, { questionId: 2, answer: 0 });
  await service.answer(session, { questionId: 3, answer: 2 });
  const summary = service.stop(session);
  assert.equal(summary.total, 3); assert.equal(summary.points, 2); assert.equal(summary.percentage, 66.7);
  assert.equal(summary.grade, 6.5); assert.equal(summary.level, 'Sufficiente');
  assert.equal(summary.review.length, 2); assert.deepEqual(summary.review[0].questions, [2]);
  assert.equal(publicQuestion(session), null);
  await assert.rejects(service.answer(session, { questionId: 4, answer: 0 }), /concluso/);
});
test('quiz completo: esito finale e suggerimenti di approfondimento', async () => {
  const { service } = makeService(); const session = await service.start(config);
  let result;
  for (let i = 0; i < 10; i++) result = await service.answer(session, { questionId: i + 1, answer: i % 4 });
  assert.equal(result.question, null); assert.equal(result.summary.points, 10); assert.equal(result.summary.level, 'Ottimo');
  assert.equal(result.summary.review.length, 2);
});
test('quiz vuoto non divide per zero e non attribuisce insufficienza', async () => {
  const { service } = makeService(); const session = await service.start(config);
  const summary = service.stop(session);
  assert.equal(summary.level, 'Non valutato'); assert.equal(summary.percentage, 0);
});
test('rifiuta concetti duplicati, output incompleti e snippet non pertinenti', async () => {
  const duplicate = generated(); duplicate.questions[1].concept = duplicate.questions[0].concept;
  await assert.rejects(makeService(duplicate).service.start(config), /ripetuto/);
  await assert.rejects(makeService({ technical: true, questions: [] }).service.start(config), /incompleto/);
  await assert.rejects(makeService({ technical: false, questions: generated('snippet').questions }).service.start({ ...config, type: 'snippet' }), /programmazione/);
});
test('argomento troppo vago: restituisce il chiarimento e non apre un quiz', async () => {
  await assert.rejects(makeService({ clarification: 'Quale periodo storico vuoi studiare?' }).service.start(config), /periodo storico/);
});
test('mix non tecnico esclude snippet e mantiene alternanza equilibrata', async () => {
  const data = generated(); data.technical = false;
  const free = generated('free');
  data.questions = data.questions.map((q, i) => i % 2 ? free.questions[i] : q);
  const session = await makeService(data).service.start({ ...config, type: 'mix' });
  assert.deepEqual(session.questions.map(q => q.type), Array.from({ length: 10 }, (_, i) => i % 2 ? 'free' : 'multiple'));
});
test('soglie e mezzi voti usano percentuali effettive', () => {
  for (const [points, level] of [[5, 'Insufficiente'], [6, 'Sufficiente'], [7.5, 'Buono'], [9, 'Ottimo']]) {
    const session = { config, questions: generated().questions, answers: Array.from({ length: 10 }, (_, i) => ({ score: Math.max(0, Math.min(1, points - i)) })) };
    assert.equal(summarize(session).level, level);
  }
});
test('provider intercambiabile: endpoint configurabile e nessuna dipendenza del dominio da Mistral', async () => {
  let called;
  const provider = createProvider({ AI_PROVIDER: 'compatible', AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'test-only', AI_MODEL: 'test-model' }, async (url, options) => {
    called = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) };
  });
  assert.deepEqual(await provider.complete({ system: 'JSON', input: { topic: 'test' } }), { ok: true });
  assert.equal(called.url, 'https://example.test/v1/chat/completions'); assert.equal(called.body.model, 'test-model');
  assert.equal(called.body.response_format.type, 'json_object');
});
test('provider: errori non espongono la risposta remota o la chiave', async () => {
  const provider = createProvider({ MISTRAL_API_KEY: 'secret-test' }, async () => ({ ok: false, status: 401 }));
  await assert.rejects(provider.complete({ system: '', input: {} }), e => !e.message.includes('secret-test') && e.message.includes('chiave API'));
  assert.throws(() => createProvider({ AI_PROVIDER: 'compatible', AI_BASE_URL: 'http://example.com' }), /HTTPS/);
});
test('input libero: riconosce gli elementi Q.U.I.Z. e scarta i valori non ammessi', async () => {
  const calls = [];
  const service = createQuizService({ async complete(request) { calls.push(request); return { type: 'multiple', topic: ' Array JavaScript ', difficulty: 'impossibile', size: 12 }; } });
  assert.deepEqual(await service.parse('12 domande impossibili a crocette sugli array'), { type: 'multiple', topic: 'Array JavaScript', difficulty: null, size: null });
  assert.equal(calls[0].input.text, '12 domande impossibili a crocette sugli array');
  const complete = createQuizService({ async complete() { return { type: 'mix', topic: 'Fotosintesi', difficulty: 'progressiva', size: '15' }; } });
  assert.deepEqual(await complete.parse('15 domande miste sulla fotosintesi dal facile al difficile'), { type: 'mix', topic: 'Fotosintesi', difficulty: 'progressiva', size: 15 });
  await assert.rejects(service.parse('x'.repeat(501)), /500 caratteri/); await assert.rejects(service.parse('  '), /500 caratteri/);
  assert.equal(calls.length, 1);
  await assert.rejects(createQuizService({ async complete() { return ['multiple']; } }).parse('quiz'), /non valida/);
});
test('multipla errata: spiega perché l’opzione scelta è sbagliata, anche dopo il riordino', async () => {
  const data = generated();
  data.questions.forEach(q => { q.optionFeedback = ['', 'Perché No è errata.', 'Perché Mai è errata.', 'Perché Sempre è errata.']; });
  const session = await createQuizService({ async complete() { return data; } }).start(config);
  for (const q of session.questions) {
    q.options.forEach((option, i) => assert.equal(q.optionFeedback[i], option === 'Sì' ? '' : `Perché ${option} è errata.`));
  }
  const wrong = session.questions[0].options.findIndex(o => o === 'Mai');
  const { result } = await createQuizService({}).answer(session, { questionId: 1, answer: wrong });
  assert.equal(result.score, 0); assert.match(result.explanation, /^Hai scelto «Mai»: Perché Mai è errata\.\n\nLa soluzione/);
  assert.equal('optionFeedback' in publicQuestion(session), false);
  const malformed = generated(); malformed.questions[0].optionFeedback = ['', 'solo una'];
  const fallback = await makeService(malformed).service.start(config);
  assert.equal(fallback.questions[0].optionFeedback, null);
  const answered = await createQuizService({}).answer(fallback, { questionId: 1, answer: 1 });
  assert.match(answered.result.explanation, /^Hai scelto «No»\.\n\nLa soluzione/);
});
test('da ripassare: 2-4 punti per area che coprono tutte le domande sbagliate o parziali', () => {
  const areas = ['Metodi', 'Metodi', 'Iterazione', 'Mutabilità', 'Ricerca', 'Ordinamento', 'Metodi', 'Iterazione', 'Ricerca', 'Ricerca'];
  const questions = generated().questions.map((q, i) => ({ ...q, area: areas[i] }));
  const scores = [0, 0.5, 0, 0, 0, 0, 1, 1, 0, 1];
  const { review } = summarize({ config, questions, answers: scores.map(score => ({ score })) });
  assert.equal(review.length, 4);
  assert.deepEqual(review.flatMap(r => r.questions).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 9]);
  assert.deepEqual(review[0].questions, [1, 2]); assert.match(review[0].text, /^Metodi: /);
  assert.deepEqual(review[3].questions, [5, 6, 9]); assert.match(review[3].text, /^Altri concetti: .*\(e altre domande collegate\)$/);
  const single = summarize({ config, questions, answers: [{ score: 1 }, { score: 0 }] }).review;
  assert.equal(single.length, 2); assert.deepEqual(single.map(r => r.questions), [[2], [2]]);
  const sameArea = summarize({ config, questions: generated().questions, answers: [{ score: 0 }, { score: 0.5 }, { score: 0 }] }).review;
  assert.equal(sameArea.length, 2); assert.deepEqual(sameArea[0].questions, [1, 2, 3]);
  assert.match(sameArea[0].text, /^Concetti generali: .*\(e altre domande collegate\)$/);
});
test('chiarimenti: indicano il passo da correggere, argomento se non specificato', async () => {
  await assert.rejects(makeService({ clarification: 'Quale parte della storia?', field: 'topic' }).service.start(config), e => e.status === 422 && e.field === 'topic');
  await assert.rejects(makeService({ clarification: 'Quale parte della storia?', field: 'size' }).service.start(config), e => e.status === 422 && e.field === 'topic');
  await assert.rejects(makeService({ clarification: 'Quale area della scienza?' }).service.start(config), e => e.status === 422 && e.field === 'topic');
  await assert.rejects(makeService({ technical: false, questions: generated('snippet').questions }).service.start({ ...config, type: 'snippet' }), e => e.field === 'type');
});
test('normalizzazione: piccole difformità accettate, controlli semantici invariati', async () => {
  const multiple = generated().questions, free = generated('free').questions, snippet = generated('snippet').questions;
  const questions = multiple.map((q, i) => [q, free[i], snippet[i]][i % 3]);
  questions[0] = { ...questions[0], type: ' Multiple ', correctIndex: '0', code: null, options: [' Sì ', 'No', 'Mai', 'Sempre'], prompt: ' Quesito 0? ' };
  questions[1] = { ...questions[1], correctIndex: -1, code: '   ' }; delete questions[1].options;
  questions[2] = { ...questions[2], code: '```js\nconst n = 1;\n```' };
  const session = await makeService({ technical: true, questions }).service.start({ ...config, type: 'mix' });
  assert.equal(session.questions[0].options[0], 'Sì'); assert.equal(session.questions[0].prompt, 'Quesito 0?');
  assert.equal(session.questions[1].correctIndex, null); assert.deepEqual(session.questions[1].options, []); assert.equal(session.questions[1].code, '');
  assert.equal(session.questions[2].code, 'const n = 1;');
  const five = normalizeQuestion({ ...generated().questions[0], options: ['A', 'B', 'C', 'D', 'E'], correctIndex: '4', optionFeedback: ['a', 'b', 'c', 'd', ''] });
  assert.deepEqual(five.options, ['A', 'B', 'C', 'E']); assert.equal(five.correctIndex, 3); assert.deepEqual(five.optionFeedback, ['a', 'b', 'c', '']);
  assert.equal(normalizeQuestion({ ...generated().questions[0], solution: undefined, correctIndex: 2 }).solution, 'Mai');
  const fiveFirst = normalizeQuestion({ ...generated().questions[0], options: ['A', 'B', 'C', 'D', 'E'], correctIndex: 0 });
  assert.deepEqual(fiveFirst.options, ['A', 'B', 'C', 'D']); assert.equal(fiveFirst.correctIndex, 0);
  const three = generated(); three.questions[0].options = ['Sì', 'No', 'Mai'];
  await assert.rejects(makeService(three).service.start(config), /Opzioni del quiz non valide/);
  const nullOptions = generated(); nullOptions.questions[0].options = null;
  await assert.rejects(makeService(nullOptions).service.start(config), /non valida/);
  assert.equal(normalizeQuestion(null), null);
});
test('duplicati: opzioni di codice diverse per punteggiatura e snippet con stessa consegna sono ammessi', async () => {
  const data = generated();
  data.questions[0].options = ['let arr = [1, 2, 3];', 'let arr = (1, 2, 3);', 'let arr = {1, 2, 3};', 'let arr = 1, 2, 3;'];
  const session = await makeService(data).service.start(config);
  assert.equal(session.questions[0].solution, 'let arr = [1, 2, 3];');
  const spaced = generated(); spaced.questions[0].options = ['[1,2]', '[1, 2]', '(1, 2)', '{1, 2}'];
  await assert.rejects(makeService(spaced).service.start(config), /Opzioni del quiz non valide/);
  const snippets = generated('snippet');
  snippets.questions.forEach((q, i) => { q.prompt = 'Cosa stampa il seguente codice?'; q.code = `console.log(${i});`; });
  assert.equal((await makeService(snippets).service.start({ ...config, type: 'snippet' })).questions.length, 10);
  snippets.questions[1].code = snippets.questions[0].code;
  await assert.rejects(makeService(snippets).service.start({ ...config, type: 'snippet' }), /ripetuto/);
});
test('codice facoltativo nelle multiple e libere, obbligatorio negli snippet', async () => {
  const data = generated(); data.questions[0].code = 'const a = [1, 2];\na.pop();';
  const session = await makeService(data).service.start(config);
  assert.equal(publicQuestion(session).code, 'const a = [1, 2];\na.pop();');
  const free = generated('free'); free.questions[0].code = 'console.log([].length);';
  assert.equal((await makeService(free).service.start({ ...config, type: 'free' })).questions[0].code, 'console.log([].length);');
  const snippet = generated('snippet'); snippet.questions[0].code = '  ';
  await assert.rejects(makeService(snippet).service.start({ ...config, type: 'snippet' }), /Formato della domanda non valido/);
});
test('verifica delle multiple: sostituisce le domande ambigue e mantiene concetto e area', async () => {
  const fix = { prompt: 'Quale letterale crea un array vuoto?', code: '', options: ['[]', '{}', '""', '0'], correctIndex: 0,
    optionFeedback: ['', 'Crea un oggetto.', 'Crea una stringa.', 'È un numero.'], solution: '[]',
    explanation: 'Le parentesi quadre creano un array. Le graffe un oggetto.', rubric: 'Riconosce il letterale.', review: 'Crea tre array diversi.' };
  const { service, calls, verifications } = makeService(generated(), [{ index: '2', question: { ...fix, concept: 'Altro', type: 'free' } }]);
  const session = await service.start(config);
  assert.equal(calls.length, 1); assert.equal(verifications.length, 1);
  assert.equal(verifications[0].input.questions.length, 10);
  assert.equal('optionFeedback' in verifications[0].input.questions[0], false);
  const replaced = session.questions[2];
  assert.equal(replaced.prompt, fix.prompt); assert.equal(replaced.type, 'multiple'); assert.equal(replaced.concept, 'Concetto 2');
  assert.equal(replaced.options[replaced.correctIndex], '[]');
  assert.equal(session.questions[3].prompt, 'Quesito 3?');
});
test('verifica delle multiple: errori o correzioni non valide lasciano il quiz generato', async () => {
  const broken = makeService(generated(), [{ index: 1, question: { options: ['solo due', 'opzioni'] } }]);
  assert.equal((await broken.service.start(config)).questions[1].prompt, 'Quesito 1?');
  let calls = 0;
  const offline = createQuizService({ async complete() { if (++calls === 1) return generated(); throw new Error('offline'); } }, n => n - 1);
  assert.equal((await offline.start(config)).questions.length, 10);
  const free = makeService(generated('free'));
  await free.service.start({ ...config, type: 'free' });
  assert.equal(free.verifications.length, 0);
});
