import { describe, expect, it } from 'vitest';

import {
  channelEventLabel,
  channelTargetError,
  NOTIFICATION_CHANNEL_EVENTS,
  toggleEvent,
} from '@/lib/notification-channels';

// Pure helpers behind the settings → Notifications section: event checklist
// state and client-side target validation (the backend re-validates,
// including the SSRF guard — this is UX-only feedback).

describe('NOTIFICATION_CHANNEL_EVENTS', () => {
  it('covers every event kind the backend emits', () => {
    const kinds = NOTIFICATION_CHANNEL_EVENTS.map((event) => event.kind);
    expect(kinds).toEqual([
      'pr_opened',
      'pr_merged',
      'pr_closed',
      'run_failed',
      'budget_exceeded',
      'task_completed',
      'merge_gate_failed',
      'job_failed',
    ]);
  });
});

describe('channelEventLabel', () => {
  it('labels known kinds and falls back for unknown ones', () => {
    expect(channelEventLabel('pr_opened')).toBe('PR opened');
    expect(channelEventLabel('merge_gate_failed')).toBe('Merge gate gave up');
    expect(channelEventLabel('something_new')).toBe('something_new');
  });
});

describe('toggleEvent', () => {
  it('adds a missing event and removes a present one', () => {
    expect(toggleEvent(['pr_opened'], 'run_failed')).toEqual(['pr_opened', 'run_failed']);
    expect(toggleEvent(['pr_opened', 'run_failed'], 'pr_opened')).toEqual(['run_failed']);
  });
});

describe('channelTargetError', () => {
  it('accepts http(s) webhook URLs and rejects everything else', () => {
    expect(channelTargetError('webhook', 'https://hooks.example.com/x')).toBeNull();
    expect(channelTargetError('webhook', 'http://localhost:9000/hook')).toBeNull();
    expect(channelTargetError('webhook', 'ftp://example.com')).toMatch(/http/);
    expect(channelTargetError('webhook', 'not a url')).toMatch(/http/);
  });

  it('accepts syntactically valid emails only', () => {
    expect(channelTargetError('email', 'ops@example.com')).toBeNull();
    expect(channelTargetError('email', 'nope@')).toMatch(/email/);
    expect(channelTargetError('email', '')).toMatch(/email/);
  });
});
