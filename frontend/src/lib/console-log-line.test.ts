/**
 * Tests for classifyConsoleLog — the classifier that turns raw agent
 * console log lines into structured UI rows (command chip, LLM metric card,
 * file-change row, error banner, …). Unit-tested; rendered by
 * components/console/ConsoleLogLine.tsx.
 */
import { describe, expect, it } from 'vitest';

import { classifyConsoleLog } from '@/lib/console-log-line';

describe('classifyConsoleLog', () => {
  it('classifies `$ git …` command echoes as command rows', () => {
    const row = classifyConsoleLog('$ git config user.email agent@lemniscate.local');
    expect(row).toEqual({
      kind: 'command',
      text: 'git config user.email agent@lemniscate.local',
    });
  });

  it('classifies the credential-helper clone echo as a command row', () => {
    const line =
      '$ git -c credential.helper=!f() { echo "x"; }; f clone --depth 1 --branch main https://example/r.git /tmp/x';
    expect(classifyConsoleLog(line)).toEqual({ kind: 'command', text: line.slice(2) });
  });

  it('parses `→ LLM call (model)` into an llm-start row', () => {
    expect(classifyConsoleLog('→ LLM call (k3)')).toEqual({ kind: 'llm-start', model: 'k3' });
  });

  it('parses `← LLM done in Xs, ~N tokens` into an llm-done row', () => {
    expect(classifyConsoleLog('← LLM done in 10.6s, ~344 tokens')).toEqual({
      kind: 'llm-done',
      seconds: '10.6',
      tokens: 344,
    });
    expect(classifyConsoleLog('← LLM done in 62s, ~12500 tokens')).toEqual({
      kind: 'llm-done',
      seconds: '62',
      tokens: 12500,
    });
  });

  it('parses `LLM retry a/b in Nms (reason)` into an llm-retry row', () => {
    expect(classifyConsoleLog('  LLM retry 2/5 in 4000ms (rate limited)')).toEqual({
      kind: 'llm-retry',
      text: 'LLM retry 2/5 in 4000ms (rate limited)',
    });
  });

  it('parses `⇄ model switch requested → model [name] — …` into a model-switch row', () => {
    const line = '⇄ model switch requested → k3 [Kimi-K3] — takes effect on the next LLM call';
    expect(classifyConsoleLog(line)).toEqual({
      kind: 'model-switch',
      text: 'model switch requested → k3 [Kimi-K3] — takes effect on the next LLM call',
    });
  });

  it('classifies `error: …` lines as errors', () => {
    expect(classifyConsoleLog('error: push access denied')).toEqual({
      kind: 'error',
      text: 'push access denied',
    });
  });

  it('keeps non-`error:` lines containing the word error as info', () => {
    expect(classifyConsoleLog('merge gate reported an error state')).toEqual({
      kind: 'info',
      text: 'merge gate reported an error state',
    });
  });

  it('parses `✎ path (action)` diff summaries into file rows', () => {
    expect(classifyConsoleLog('✎ src/app.ts (modified)')).toEqual({
      kind: 'file',
      path: 'src/app.ts',
      action: 'modified',
    });
    expect(classifyConsoleLog('✎ src/new.ts (created)')).toEqual({
      kind: 'file',
      path: 'src/new.ts',
      action: 'created',
    });
    expect(classifyConsoleLog('✎ src/old.ts (deleted)')).toEqual({
      kind: 'file',
      path: 'src/old.ts',
      action: 'deleted',
    });
  });

  it('treats unknown diff actions as plain modified styling', () => {
    expect(classifyConsoleLog('✎ src/x.ts (renamed)')).toEqual({
      kind: 'file',
      path: 'src/x.ts',
      action: 'modified',
    });
  });

  it('classifies agent_step text fallback `[kind] tool: title (status)` as info', () => {
    expect(classifyConsoleLog('[tool] bash: run tests (running)')).toEqual({
      kind: 'info',
      text: '[tool] bash: run tests (running)',
    });
  });

  it('passes plain status lines through as info rows', () => {
    for (const line of [
      'checking repository push access',
      'starting task "fix the thing" on grig-teo/lemniscate',
      'cloning grig-teo/lemniscate (main)',
      'clone complete (main)',
      'created branch lemniscate/skip-llm-when-process-stalled',
      'executor: lemcore',
      'running lemcore agent',
      'scanning repository into codebase graph',
    ]) {
      expect(classifyConsoleLog(line)).toEqual({ kind: 'info', text: line });
    }
  });
});
