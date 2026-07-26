import { describe, expect, it, vi } from 'vitest';

// Unit tests for the merge-gate decision function: auto-merge only happens
// on green checks, pending waits (bounded), failing triggers a bounded
// hermes CI fix, everything else falls back to manual.

vi.mock('../src/config.js', () => ({
  config: { AGENT_WORKDIR: '/tmp/test-workdirs', AGENT_EXECUTOR: 'hermes', AGENT_HERMES_TIMEOUT_MINUTES: 45 },
}));
vi.mock('../src/lib/agent-git.js', () => ({}));
vi.mock('../src/lib/agent-runtime.js', () => ({}));
vi.mock('../src/lib/hermes-runner.js', () => ({}));
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
  MERGE_GATE_MAX_ATTEMPTS,
  mergeGateAction,
} from '../src/lib/merge-gate.js';

const green = { supported: true, green: true, state: 'green' as const };
const pending = { supported: true, green: false, state: 'pending' as const };
const failing = { supported: true, green: false, state: 'failing' as const };
const unsupported = { supported: false, green: true, state: 'green' as const };

describe('mergeGateAction', () => {
  it('merges when checks are green', () => {
    expect(mergeGateAction(green, 0, 0, 'hermes')).toBe('merge');
  });

  it('merges unverified when the provider has no checks API', () => {
    expect(mergeGateAction(unsupported, 0, 0, 'hermes')).toBe('merge');
  });

  it('waits while checks are pending', () => {
    expect(mergeGateAction(pending, 0, 0, 'hermes')).toBe('wait');
    expect(mergeGateAction(pending, MERGE_GATE_MAX_ATTEMPTS - 1, 0, 'hermes')).toBe('wait');
  });

  it('gives up to manual after too many pending re-checks', () => {
    expect(mergeGateAction(pending, MERGE_GATE_MAX_ATTEMPTS, 0, 'hermes')).toBe('manual');
  });

  it('fixes failing checks with hermes', () => {
    expect(mergeGateAction(failing, 0, 0, 'hermes')).toBe('fix-ci');
    expect(mergeGateAction(failing, 0, MAX_CI_FIX_ATTEMPTS - 1, 'hermes')).toBe('fix-ci');
  });

  it('gives up to manual after too many CI fixes', () => {
    expect(mergeGateAction(failing, 0, MAX_CI_FIX_ATTEMPTS, 'hermes')).toBe('manual');
  });

  it('never CI-fixes on the internal executor', () => {
    expect(mergeGateAction(failing, 0, 0, 'internal')).toBe('manual');
  });
});
