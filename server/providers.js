// Contratto del provider: async complete({ system, input }) => oggetto JSON.
// La logica del quiz dipende solo da questo contratto.
export function createProvider(env = process.env, fetcher = fetch) {
  const name = env.AI_PROVIDER || 'mistral';
  if (!['mistral', 'compatible'].includes(name)) throw new Error('AI_PROVIDER non supportato. Usa mistral o compatible.');
  const key = name === 'mistral' ? env.MISTRAL_API_KEY : env.AI_API_KEY;
  const base = name === 'mistral' ? 'https://api.mistral.ai/v1' : env.AI_BASE_URL;
  const model = env.AI_MODEL || (name === 'mistral' ? 'mistral-small-latest' : '');
  if (base) {
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Il provider deve usare HTTPS (HTTP consentito solo in locale).');
    }
  }
  return {
    name,
    configured: Boolean(key && base && model),
    async complete({ system, input }) {
      if (!key || !base || !model) throw new Error('Configura la chiave API e il modello nel file .env, poi riavvia il server.');
      let response;
      try {
        response = await fetcher(`${base.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.4, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
        });
      } catch {
        throw new Error('Il provider AI non è raggiungibile o ha impiegato troppo tempo. Riprova.');
      }
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new Error('Il provider AI ha rifiutato la chiave API. Controlla il file .env.');
        if (response.status === 429) throw new Error('Limite del provider AI raggiunto. Attendi e riprova.');
        throw new Error(`Il provider AI ha restituito un errore (${response.status}). Controlla modello e configurazione.`);
      }
      try {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || data.choices[0].finish_reason === 'length') throw new Error();
        return JSON.parse(content);
      } catch {
        throw new Error('Risposta AI incompleta o non valida. Riprova.');
      }
    },
  };
}
