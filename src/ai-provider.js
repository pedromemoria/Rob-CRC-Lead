import OpenAI from 'openai';

const geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function unavailable(status) {
  return Object.assign(new Error('Provedor de IA indisponível'), { status });
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
  if (!response.ok) throw unavailable(response.status);
  const body = await response.json();
  const calls = body?.candidates?.[0]?.content?.parts?.filter(part => !part.thought && part.functionCall)
    .map(({ functionCall }) => ({
      type: 'function', function: { name: functionCall.name, arguments: JSON.stringify(functionCall.args ?? {}) }
    }));
  if (calls?.length !== 1 || !request.tools.some(tool => tool.function.name === calls[0].function.name)) {
    throw unavailable(502);
  }
  return { choices: [{ message: { tool_calls: calls } }] };
}

export function createAIProvider({ geminiKey, openai }, { fetcher = fetch, fallback } = {}) {
  const client = fallback ?? (openai.apiKey ? new OpenAI({ apiKey: openai.apiKey, timeout: 14_000, maxRetries: 0 }) : null);
  return { chat: { completions: { async create(request) {
    if (geminiKey) {
      try { return await geminiCompletion(geminiKey, request, fetcher); }
      catch (error) { if (!client) throw unavailable(Number.isInteger(error?.status) ? error.status : 502); }
    }
    if (!client) throw unavailable(503);
    return client.chat.completions.create(request);
  } } } };
}
