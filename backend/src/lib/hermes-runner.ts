import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logBatch } from './agent-git.js';
import { LineBatcher } from './line-batcher.js';
import { prisma } from './prisma.js';
import { redactSecrets } from './utils.js';

// Runs the Hermes Agent CLI non-interactively (`hermes chat -q <prompt>`)
// inside a freshly cloned repository. Hermes gets an isolated HERMES_HOME
// (written per run from the task's LLM config) and auto-approves its tools
// via HERMES_YOLO_MODE=1. With a taskId, output streams line by line to the
// task console (ANSI-stripped, secret-redacted) and cancellation is polled;
// without one, output only feeds the tail used in error messages.

export interface HermesLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
}

export interface HermesTaskOptions {
  workdir: string;
  prompt: string;
  llm: HermesLlmConfig;
  /**
   * Owning task for console streaming + cancellation. Omit for runs with no
   * task console (e.g. generate-proposals): output still feeds the error
   * tail, but nothing is logged and no cancel poll runs.
   */
  taskId?: string;
  secrets: string[];
  timeoutMs: number;
  /** Cancel-poll interval; defaults to CANCEL_POLL_MS. */
  pollMs?: number;
}

const HERMES_HOME_DIR = '.hermes-home';
const OUTPUT_TAIL_CHARS = 500;
const CANCEL_POLL_MS = 5_000;
// Line coalescing: buffer agent stdout/stderr and flush as a single batched
// log event. Cuts DB writes ~10x without perceptible console lag.
const BATCH_MAX_LINES = 50;
const BATCH_FLUSH_MS = 500;

// The cancel endpoint marks the task failed; the runner notices on the next
// poll and kills the agent — a real stop, not just a status flip.
async function taskIsCancelled(taskId: string): Promise<boolean> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    return task?.status === 'failed';
  } catch {
    return false;
  }
}

// Strips ANSI escape sequences (SGR colors, cursor moves, OSC titles).
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g,
    '',
  );
}

// Emits a double-quoted YAML scalar. YAML is a JSON superset, so JSON.stringify
// produces exactly a valid YAML double-quoted scalar with `\` and `"` escaped —
// safe for any string (api keys with `#`, urls with fragments, models with `: `).
// No raw-interpolated value may appear in config.yaml without passing through it.
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

// config.yaml for a custom OpenAI-compatible endpoint. api_mode is pinned:
// left to auto-detect, Hermes picks the anthropic_messages transport for
// coding endpoints (kimi/z.ai) and then fails on a missing optional package.
export function hermesConfigYaml(llm: HermesLlmConfig): string {
  return [
    'model:',
    `  default: ${yamlScalar(llm.model)}`,
    '  provider: custom',
    '  api_mode: chat_completions',
    `  base_url: ${yamlScalar(llm.baseUrl)}`,
    `  api_key: ${yamlScalar(llm.apiKey)}`,
    `  context_length: ${llm.contextWindow}`,
    '',
  ].join('\n');
}

// Keeps .hermes-home out of the commit the surrounding flow may create.
async function ensureGitExclude(workdir: string): Promise<void> {
  const excludePath = path.join(workdir, '.git', 'info', 'exclude');
  const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
  if (existing.split('\n').includes(`${HERMES_HOME_DIR}/`)) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(excludePath, `${separator}${HERMES_HOME_DIR}/\n`);
}

async function writeHermesHome(workdir: string, llm: HermesLlmConfig): Promise<string> {
  const hermesHome = path.join(workdir, HERMES_HOME_DIR);
  await fs.mkdir(hermesHome, { recursive: true });
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), hermesConfigYaml(llm), 'utf8');
  await ensureGitExclude(workdir);
  return hermesHome;
}

// Sliding window over recent output, used in failure messages.
function makeOutputTail(maxChars: number): { push: (line: string) => void; text: () => string } {
  let buffer = '';
  return {
    push(line: string): void {
      buffer = `${buffer}${line}\n`.slice(-maxChars);
    },
    text(): string {
      return buffer.trim();
    },
  };
}

type OutputTail = ReturnType<typeof makeOutputTail>;

// Creates a readline interface over the stream, pushing each processed line
// to the output tail and (when a taskId is set) to the LineBatcher for
// coalesced DB writes. Returns the batcher so the caller can flush on close.
function streamLines(
  stream: NodeJS.ReadableStream,
  opts: HermesTaskOptions,
  tail: OutputTail,
): LineBatcher | undefined {
  const rl = readline.createInterface({ input: stream, terminal: false });
  if (!opts.taskId) {
    rl.on('line', (raw) => tail.push(redactSecrets(stripAnsi(raw), opts.secrets)));
    return undefined;
  }
  const batcher = new LineBatcher(
    (lines) => logBatch(opts.taskId!, lines),
    BATCH_MAX_LINES,
    BATCH_FLUSH_MS,
  );
  rl.on('line', (raw) => {
    const line = redactSecrets(stripAnsi(raw), opts.secrets);
    tail.push(line);
    batcher.push(line);
  });
  rl.on('close', () => batcher.close());
  return batcher;
}

function spawnError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT') return new Error('hermes CLI not installed in the worker image');
  return err;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`hermes agent timed out after ${Math.round(timeoutMs / 1000)}s`);
}

function waitForHermes(child: ChildProcess, opts: HermesTaskOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const tail = makeOutputTail(OUTPUT_TAIL_CHARS);
    const taskId = opts.taskId;
    const cancelPoll = taskId
      ? setInterval(() => {
          void taskIsCancelled(taskId).then((cancelled) => {
            if (!cancelled) return;
            child.kill('SIGKILL');
            reject(new Error('cancelled by user'));
          });
        }, opts.pollMs ?? CANCEL_POLL_MS)
      : undefined;
    const batchers: LineBatcher[] = [];
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      if (cancelPoll) clearInterval(cancelPoll);
      batchers.forEach((b) => b.close());
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(timeoutError(opts.timeoutMs));
      });
    }, opts.timeoutMs);
    if (child.stdout) {
      const b = streamLines(child.stdout, opts, tail);
      if (b) batchers.push(b);
    }
    if (child.stderr) {
      const b = streamLines(child.stderr, opts, tail);
      if (b) batchers.push(b);
    }
    child.on('error', (err) => {
      settle(() => reject(spawnError(err as NodeJS.ErrnoException)));
    });
// Hermes prints an init-failure banner but still exits 0 — without this
// marker check a broken run would look like "no changes produced".
const INIT_FAILURE_MARKER = 'Failed to initialize agent';

    child.on('close', (code) => {
      if (tail.text().includes(INIT_FAILURE_MARKER)) {
        settle(() => reject(new Error(`hermes agent failed to initialize: ${tail.text()}`)));
        return;
      }
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`hermes agent exited with code ${code}: ${tail.text()}`)));
    });
  });
}

// Env allowlist for the hermes child. The agent runs in YOLO mode with the
// user's prompt, so it must NOT inherit worker secrets (DATABASE_URL,
// ENCRYPTION_KEY, JWT_SECRET, OAuth tokens). Only the variables hermes needs
// to run plus optional proxy settings pass through.
const HERMES_ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'] as const;
const HERMES_ENV_PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;

export function buildHermesEnv(hermesHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HERMES_HOME: hermesHome, HERMES_YOLO_MODE: '1' };
  for (const key of [...HERMES_ENV_PASSTHROUGH, ...HERMES_ENV_PROXY]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function runHermesTask(opts: HermesTaskOptions): Promise<void> {
  const hermesHome = await writeHermesHome(opts.workdir, opts.llm);
  const env = buildHermesEnv(hermesHome);
  // spawn (never a shell): the prompt travels as a single argv element, so
  // quotes, backticks, or $(...) in it cannot be interpreted by a shell.
  const child = spawn('hermes', ['chat', '-q', opts.prompt], { cwd: opts.workdir, env });
  await waitForHermes(child, opts);
}
