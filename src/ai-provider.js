import OpenAI from 'openai';

const geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function unavailable(status, code) {
  return Object.assign(new Error('Provedor de IA indisponível'), { status, code });
}

const knownCodes = new Set(['API_KEY_INVALID', 'insufficient_quota', 'invalid_api_key', 'model_not_found']);

function failedAttempt(provider, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const code = knownCodes.has(error?.code) ? error.code : undefined;
  return { provider, status, code };
}

export class AIProviderError extends Error {
  constructor(attempts) {
    super('Provedores de IA indisponíveis');
    this.attempts = attempts;
    this.status = attempts.at(-1)?.status ?? 503;
  }
}

export function providerFailureMessage(error) {
  if (!(error instanceof AIProviderError)) return null;
  if (!error.attempts.length) return 'Configure uma chave do Gemini ou da OpenAI para usar a IA.';
  const messages = error.attempts.map(({ provider, status, code }) => {
    let reason = 'serviço indisponível';
    if (code === 'API_KEY_INVALID' || code === 'invalid_api_key' || status === 401) reason = 'chave recusada';
    else if (code === 'insufficient_quota') reason = 'cota ou créditos insuficientes';
    else if (status === 403) reason = 'acesso negado';
    else if (status === 429) reason = 'limite de uso ou cota atingido';
    else if (status === 404 || code === 'model_not_found') reason = 'modelo indisponível para a conta';
    else if (status === 400) reason = 'requisição recusada';
    return provider + ' (' + status + ', ' + reason + ')';
  });
  return 'Falha ao consultar a IA. ' + messages.join('. ') + '.';
}

async function geminiCompletion(key, request, fetcher) {
  const response = await fetcher(geminiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(14_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.messages[0].content }] },
      contents: [{ role: 'user', parts: [{ text: request.messages[1].content }] }],
      tools: [{ functionDeclarations: request.tools.map(({ function: fn }) => ({
        name: fn.name, description: fn.description,
        parameters: { type: 'OBJECT', required: fn.parameters.required, properties:
          Object.fromEntries(Object.entries(fn.parameters.properties).map(([name, value]) => [
            name, { ...value, type: value.type.toUpperCase() }
          ])) }
      })) }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const details = body?.error?.details;
    const reason = Array.isArray(details) ? details.find(item => item?.reason === 'API_KEY_INVALID')?.reason : undefined;
    throw unavailable(response.status, reason);
  }
  const body = await response.json();
  const calls = body?.candidates?.[0]?.content?.parts?.filter(part => !part.thought && part.functionCall)
    .map(({ functionCall }) => ({
      type: 'function', function: { name: functionCall.name, arguments: JSON.stringify(functionCall.args ?? {}) }
    }));
  if (calls?.length !== 1 || !request.tools.some(tool => tool.function.name === calls[0].function.name)) {
    throw unavailable(502);
  }
  return { provider: 'Gemini', choices: [{ message: { tool_calls: calls } }] };
}

export function createAIProvider({ geminiKey, openai }, { fetcher = fetch, fallback } = {}) {
  const client = fallback ?? (openai.apiKey ? new OpenAI({ apiKey: openai.apiKey, timeout: 14_000, maxRetries: 0 }) : null);
  return { chat: { completions: { async create(request) {
    const attempts = [];
    if (geminiKey) {
      try { return await geminiCompletion(geminiKey, request, fetcher); }
      catch (error) { attempts.push(failedAttempt('Gemini', error)); }
    }
    if (client) {
      try { return { ...await client.chat.completions.create(request), provider: 'OpenAI' }; }
      catch (error) { attempts.push(failedAttempt('OpenAI', error)); }
    }
    throw new AIProviderError(attempts);
  } } } };
}
