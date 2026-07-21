import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';
import { redactSecrets } from './utils.js';

// Runs the Hermes Agent CLI non-interactively (`hermes chat -q <prompt>`)
// inside a freshly cloned repository. Hermes gets an isolated HERMES_HOME
// (written per run from the task's LLM config) and auto-approves its tools
// via HERMES_YOLO_MODE=1. Output streams line by line to the task console,
// ANSI-stripped and secret-redacted.

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
  taskId: string;
  secrets: string[];
  timeoutMs: number;
  /** Cancel-poll interval; defaults to CANCEL_POLL_MS. */
  pollMs?: number;
}

const HERMES_HOME_DIR = '.hermes-home';
const OUTPUT_TAIL_CHARS = 500;
const CANCEL_POLL_MS = 5_000;

// The cancel endpoint marks the task failed; the runner notices on the next
// poll and kills the agent — a real stop, not just a status flip.
async function taskIsCancelled(taskId: string): Promise<boolean> {
  const task = await prisma.task
    .findUnique({ where: { id: taskId }, select: { status: true } })
    .catch(() => null);
  return task?.status === 'failed';
}

// Strips ANSI escape sequences (SGR colors, cursor moves, OSC titles).
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g,
    '',
  );
}

// config.yaml for a custom OpenAI-compatible endpoint. api_mode is pinned:
// left to auto-detect, Hermes picks the anthropic_messages transport for
// coding endpoints (kimi/z.ai) and then fails on a missing optional package.
export function hermesConfigYaml(llm: HermesLlmConfig): string {
  return [
    'model:',
    `  default: ${llm.model}`,
    '  provider: custom',
    '  api_mode: chat_completions',
    `  base_url: ${llm.baseUrl}`,
    `  api_key: ${llm.apiKey}`,
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

function streamLines(
  stream: NodeJS.ReadableStream,
  opts: HermesTaskOptions,
  tail: OutputTail,
): void {
  const rl = readline.createInterface({ input: stream, terminal: false });
  rl.on('line', (raw) => {
    const line = redactSecrets(stripAnsi(raw), opts.secrets);
    tail.push(line);
    void logEvent(opts.taskId, line).catch(() => {});
  });
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
    const cancelPoll = setInterval(() => {
      void taskIsCancelled(opts.taskId).then((cancelled) => {
        if (!cancelled) return;
        child.kill('SIGKILL');
        reject(new Error('cancelled by user'));
      });
    }, opts.pollMs ?? CANCEL_POLL_MS);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      clearInterval(cancelPoll);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(timeoutError(opts.timeoutMs));
      });
    }, opts.timeoutMs);
    if (child.stdout) streamLines(child.stdout, opts, tail);
    if (child.stderr) streamLines(child.stderr, opts, tail);
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

export async function runHermesTask(opts: HermesTaskOptions): Promise<void> {
  const hermesHome = await writeHermesHome(opts.workdir, opts.llm);
  const env = { ...process.env, HERMES_HOME: hermesHome, HERMES_YOLO_MODE: '1' };
  // spawn (never a shell): the prompt travels as a single argv element, so
  // quotes, backticks, or $(...) in it cannot be interpreted by a shell.
  const child = spawn('hermes', ['chat', '-q', opts.prompt], { cwd: opts.workdir, env });
  await waitForHermes(child, opts);
}
