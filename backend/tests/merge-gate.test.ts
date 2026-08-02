import { describe, expect, it, vi } from 'vitest';

// Unit tests for the merge-gate decision function: auto-merge only happens
// on green checks, pending waits (bounded), failing triggers a bounded
// lemcore CI fix, everything else falls back to manual.

vi.mock('../src/config.js', () => ({
  config: { AGENT_WORKDIR: '/tmp/test-workdirs' },
}));
vi.mock('../src/lib/agent-git.js', () => ({}));
vi.mock('../src/lib/agent-runtime.js', () => ({}));
vi.mock('../src/lib/lemcore/run.js', () => ({}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({}));
// deploy-service imports lib/crypto at module load, which reads
// config.ENCRYPTION_KEY — absent from the partial config mock above.
vi.mock('../src/lib/deploy/deploy-service.js', () => ({}));
vi.mock('../src/lib/pull-requests.js', () => ({}));
vi.mock('../src/lib/task-events.js', () => ({}));
// merge-gate notifies on merged/gave-up; the emitters pull in lib/crypto
// (ENCRYPTION_KEY absent from the partial config mock above). Notification
// fan-out is covered in notification-delivery.test.ts.
vi.mock('../src/lib/notifications.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyOncePerTask: vi.fn().mockResolvedValue(undefined),
}));

import {
  MAX_CI_FIX_ATTEMPTS,
  MAX_REBASE_RETRIES,
  MERGE_GATE_MAX_ATTEMPTS,
  mergeGateAction,
} from '../src/lib/merge-gate.js';

const green = { supported: true, green: true, state: 'green' as const };
const pending = { supported: true, green: false, state: 'pending' as const };
const failing = { supported: true, green: false, state: 'failing' as const };
const unsupported = { supported: false, green: true, state: 'green' as const };

describe('mergeGateAction', () => {
  it('merges when checks are green', () => {
    expect(mergeGateAction(green, 0, 0)).toBe('merge');
  });

  it('merges unverified when the provider has no checks API', () => {
    expect(mergeGateAction(unsupported, 0, 0)).toBe('merge');
  });

  it('waits while checks are pending', () => {
    expect(mergeGateAction(pending, 0, 0)).toBe('wait');
    expect(mergeGateAction(pending, MERGE_GATE_MAX_ATTEMPTS - 1, 0)).toBe('wait');
  });

  it('gives up to manual after too many pending re-checks', () => {
    expect(mergeGateAction(pending, MERGE_GATE_MAX_ATTEMPTS, 0)).toBe('manual');
  });

  it('fixes failing checks with lemcore', () => {
    expect(mergeGateAction(failing, 0, 0)).toBe('fix-ci');
    expect(mergeGateAction(failing, 0, MAX_CI_FIX_ATTEMPTS - 1)).toBe('fix-ci');
  });

  it('forces one rebase + fresh fix budget when CI fixes are exhausted', () => {
    expect(mergeGateAction(failing, 0, MAX_CI_FIX_ATTEMPTS)).toBe('rebase-retry');
  });

  it('gives up to manual only after the rebase retry is spent too', () => {
    expect(mergeGateAction(failing, 0, MAX_CI_FIX_ATTEMPTS, MAX_REBASE_RETRIES)).toBe('manual');
  });
});
