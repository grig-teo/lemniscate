import { beforeEach, describe, expect, it } from 'vitest';

import {
  checkToolCallLoop,
  LOOP_BLOCK_AT,
  LOOP_NUDGE_AT,
  resetLoopDetection,
} from '../src/lib/lemcore/loop-detector.js';

// Locking tests for the loop detector: identical read-only calls are warned
// at LOOP_NUDGE_AT and blocked at LOOP_BLOCK_AT; bash/mutating tools are
// never tracked (repeated tests/edits are legitimate fix-verify cycles).
const WD = 'wd-loop-test';

beforeEach(() => resetLoopDetection(WD));

describe('checkToolCallLoop', () => {
  it('lets the first identical calls through silently', () => {
    expect(checkToolCallLoop(WD, 'grep', { pattern: 'foo' }).blocked).toBe(false);
    expect(checkToolCallLoop(WD, 'grep', { pattern: 'foo' }).note).toBeUndefined();
  });

  it('nudges (without blocking) at LOOP_NUDGE_AT identical calls', () => {
    let last = checkToolCallLoop(WD, 'read_file', { path: 'a.ts' });
    for (let i = 1; i < LOOP_NUDGE_AT; i += 1) {
      last = checkToolCallLoop(WD, 'read_file', { path: 'a.ts' });
    }
    expect(last.blocked).toBe(false);
    expect(last.note).toContain('loop-detection');
    expect(last.note).toContain(`${LOOP_NUDGE_AT} times`);
  });

  it('blocks at LOOP_BLOCK_AT identical calls with a corrective error', () => {
    let last = checkToolCallLoop(WD, 'grep', { pattern: 'foo' });
    for (let i = 1; i < LOOP_BLOCK_AT; i += 1) {
      last = checkToolCallLoop(WD, 'grep', { pattern: 'foo' });
    }
    expect(last.blocked).toBe(true);
    expect(last.note).toContain('blocked');
  });

  it('tracks different args independently', () => {
    for (let i = 0; i < LOOP_BLOCK_AT; i += 1) checkToolCallLoop(WD, 'grep', { pattern: 'a' });
    expect(checkToolCallLoop(WD, 'grep', { pattern: 'b' }).blocked).toBe(false);
  });

  it('ignores bash and mutating tools entirely', () => {
    for (let i = 0; i < LOOP_BLOCK_AT + 2; i += 1) {
      expect(checkToolCallLoop(WD, 'bash', { command: 'npm test' }).blocked).toBe(false);
      expect(checkToolCallLoop(WD, 'edit_file', { path: 'a.ts' }).blocked).toBe(false);
    }
  });

  it('resetLoopDetection clears the counters', () => {
    for (let i = 0; i < LOOP_BLOCK_AT; i += 1) checkToolCallLoop(WD, 'glob', { pattern: '*.ts' });
    resetLoopDetection(WD);
    expect(checkToolCallLoop(WD, 'glob', { pattern: '*.ts' }).blocked).toBe(false);
  });
});
