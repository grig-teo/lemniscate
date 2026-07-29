/** Shared OpenAI tool-calling types and argument parsing for llm-client / lemcore. */

export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Parse tool-call arguments that may be a JSON string or already an object. */
export function parseToolCallArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Error(`tool arguments are not a JSON object: ${String(raw).slice(0, 200)}`);
}

export function normalizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const fn = rec.function;
    if (!fn || typeof fn !== 'object') continue;
    const fnRec = fn as Record<string, unknown>;
    const name = typeof fnRec.name === 'string' ? fnRec.name : '';
    if (!name) continue;
    const args =
      typeof fnRec.arguments === 'string'
        ? fnRec.arguments
        : JSON.stringify(fnRec.arguments ?? {});
    out.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : `call_${out.length + 1}`,
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return out;
}
