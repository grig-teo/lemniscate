// Mock OpenAI-compatible LLM edge for the e2e suite — the ONLY stub left in
// this container; the git provider role is served by a real Gitea container
// (see tests/e2e/docker-compose.e2e.yml) that nginx proxies to.
//
//   :8081  OpenAI-compatible chat-completions endpoint (plain HTTP, reached
//          by the worker as the LLM baseUrl http://gitstub:8081/v1). The
//          scenario routing lives in llm-router.mjs (unit-tested from
//          backend/tests/e2e-stub-llm-router.test.ts).
//
// Every request is logged to stdout so `docker compose logs gitstub`
// (uploaded as a CI artifact on failure) shows exactly what the stack asked.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { completionResponse } from './llm-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHANGES_FIXTURE = readFileSync(path.join(HERE, 'llm-fixture.json'), 'utf8').trim();
const FIX_FIXTURE = readFileSync(path.join(HERE, 'llm-fixture-fix.json'), 'utf8').trim();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function llmHandler(req, res) {
  console.log(`[llm-stub] ${req.method} ${req.url}`);
  const url = new URL(req.url ?? '/', 'http://stub');
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    return sendJson(res, 404, { error: `stub llm: no route for ${req.method} ${url.pathname}` });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const routed = completionResponse(body.messages ?? [], hasTools, CHANGES_FIXTURE, FIX_FIXTURE);
  const message =
    routed.type === 'tool_calls'
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_e2e_stub_1',
              type: 'function',
              function: { name: routed.name, arguments: JSON.stringify(routed.arguments) },
            },
          ],
        }
      : { role: 'assistant', content: routed.content };
  return sendJson(res, 200, {
    id: 'chatcmpl-e2e-stub',
    object: 'chat.completion',
    created: 0,
    model: body.model ?? 'stub-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: routed.type === 'tool_calls' ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  });
}

createServer((req, res) => {
  llmHandler(req, res).catch((err) => {
    console.error('[llm-stub] handler error:', err);
    sendJson(res, 500, { error: 'stub llm internal error' });
  });
}).listen(8081, '0.0.0.0', () => {
  console.log('[llm-stub] listening on 0.0.0.0:8081');
});
