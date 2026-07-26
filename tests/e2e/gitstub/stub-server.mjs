// Stub network edges for the e2e smoke suite. Two HTTP servers in one
// process:
//
//   :8080  GitVerse-shaped provider API (loopback only — nginx terminates
//          TLS for `api.gitstub` and proxies here). Implements exactly the
//          endpoints the backend's gitverse provider client calls:
//            GET /user                              profile lookup (PAT connect)
//            GET /user/repos                        repository sync
//            GET /repos/:full                       push-access preflight
//            GET /repos/:full/contents              root listing (bare/platform)
//
//   :8081  OpenAI-compatible chat-completions endpoint (plain HTTP, reached
//          by the worker as the LLM baseUrl http://gitstub:8081/v1). Answers
//          deterministically based on the prompt:
//            - branch-slug prompt     -> "e2e-smoke"
//            - commit-message prompt  -> a fixed conventional-commit line
//            - anything else          -> the change-set JSON from
//                                        llm-fixture.json (single source of
//                                        truth, locked by a backend unit test:
//                                        backend/tests/e2e-stub-llm-fixture.test.ts)
//
// Every request is logged to stdout so `docker compose logs gitstub`
// (uploaded as a CI artifact on failure) shows exactly what the stack asked.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHANGES_FIXTURE = readFileSync(path.join(HERE, 'llm-fixture.json'), 'utf8').trim();

const REPO_FULL_NAME = 'e2e-user/e2e-repo';
const BRANCH_SLUG_REPLY = 'e2e-smoke';
const COMMIT_MESSAGE_REPLY = 'feat: add e2e smoke marker file';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function logLine(server, req) {
  console.log(`[${server}] ${req.method} ${req.url}`);
}

// --- Provider API ----------------------------------------------------------

function providerApiHandler(req, res) {
  logLine('provider-api', req);
  const url = new URL(req.url ?? '/', 'http://stub');
  if (req.method === 'GET' && url.pathname === '/user') {
    return sendJson(res, 200, { login: 'e2e-user' });
  }
  if (req.method === 'GET' && url.pathname === '/user/repos') {
    return sendJson(res, 200, [
      {
        id: 1,
        name: 'e2e-repo',
        full_name: REPO_FULL_NAME,
        clone_url: 'https://gitstub/e2e-repo.git',
        default_branch: 'main',
      },
    ]);
  }
  if (req.method === 'GET' && url.pathname === `/repos/${REPO_FULL_NAME}`) {
    return sendJson(res, 200, { full_name: REPO_FULL_NAME, permissions: { push: true } });
  }
  if (req.method === 'GET' && url.pathname === `/repos/${REPO_FULL_NAME}/contents`) {
    // Matches the git fixture baked into the image (README.md + src/).
    return sendJson(res, 200, [
      { name: 'README.md', type: 'file' },
      { name: 'src', type: 'dir' },
    ]);
  }
  return sendJson(res, 404, { error: `stub provider: no route for ${req.method} ${url.pathname}` });
}

// --- LLM stub --------------------------------------------------------------

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function completionContent(messages) {
  const text = messages.map(messageText).join('\n');
  if (text.includes('branch slug')) return BRANCH_SLUG_REPLY;
  if (text.includes('conventional-commit')) return COMMIT_MESSAGE_REPLY;
  return CHANGES_FIXTURE;
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
  logLine('llm-stub', req);
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
  const content = completionContent(body.messages ?? []);
  return sendJson(res, 200, {
    id: 'chatcmpl-e2e-stub',
    object: 'chat.completion',
    created: 0,
    model: body.model ?? 'stub-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  });
}

createServer(providerApiHandler).listen(8080, '127.0.0.1', () => {
  console.log('[provider-api] listening on 127.0.0.1:8080');
});
createServer((req, res) => {
  llmHandler(req, res).catch((err) => {
    console.error('[llm-stub] handler error:', err);
    sendJson(res, 500, { error: 'stub llm internal error' });
  });
}).listen(8081, '0.0.0.0', () => {
  console.log('[llm-stub] listening on 0.0.0.0:8081');
});
