// OpenAI ChatMessage → Anthropic Messages API shape (including tool_use).
import type { ChatCompletionTool, ChatMessage, ContentPart } from './llm-client.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export type AnthropicContent = string | AnthropicBlock[];

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

function imagePartToBlock(part: Extract<ContentPart, { type: 'image_url' }>): AnthropicBlock {
  const url = part.image_url.url;
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (dataUrl) {
    const [, mediaType = 'image/png', data = ''] = dataUrl;
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function textOrParts(content: string | ContentPart[] | null): AnthropicBlock[] {
  if (content === null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) =>
    part.type === 'text' ? { type: 'text' as const, text: part.text } : imagePartToBlock(part),
  );
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { _raw: raw };
}

function assistantToAnthropic(message: Extract<ChatMessage, { role: 'assistant' }>): AnthropicMessage {
  const blocks = textOrParts(message.content);
  for (const tc of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: parseArgs(tc.function.arguments),
    });
  }
  if (blocks.length === 0) return { role: 'assistant', content: '' };
  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return { role: 'assistant', content: blocks[0].text };
  }
  return { role: 'assistant', content: blocks };
}

/** Split system out; map tool_calls ↔ tool_use and tool results ↔ tool_result. */
export function toAnthropicRequest(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicBlock[] = [];

  const flushTools = () => {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
      });
      continue;
    }
    flushTools();
    if (message.role === 'assistant') {
      converted.push(assistantToAnthropic(message));
      continue;
    }
    // user
    const blocks = textOrParts(message.content);
    if (blocks.length === 0) converted.push({ role: 'user', content: '' });
    else if (blocks.length === 1 && blocks[0]?.type === 'text') {
      converted.push({ role: 'user', content: blocks[0].text });
    } else converted.push({ role: 'user', content: blocks });
  }
  flushTools();

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: converted,
  };
}

export function toAnthropicTools(tools: ChatCompletionTool[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}
