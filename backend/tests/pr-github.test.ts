import { describe, expect, it } from 'vitest';
import { githubChecksState } from '../src/lib/pr-github.js';

// Locking tests for the auto-merge gate's GitHub CI signal. Regression: the
// gate used to read ONLY the combined commit-status endpoint, which GitHub
// Actions never reports to — on an Actions-only repo total_count is 0, the
// old code mapped that to 'green', and PRs merged while CI was red (observed
// live: Frontend green + Backend failure merged onto main).
// The gate now combines BOTH signals: commit statuses (external CI) and
// check runs (GitHub Actions).

describe('githubChecksState', () => {
  it('treats a commit with no statuses and no check runs as green', () => {
    expect(githubChecksState({ state: 'pending', total_count: 0 }, [])).toBe('green');
  });

  it('is green when statuses succeed and check runs succeed', () => {
    expect(
      githubChecksState({ state: 'success', total_count: 2 }, [
        { status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('green');
  });

  it('is failing when any check run failed — even with zero commit statuses', () => {
    // The exact reported bug: Actions-only repo, backend job red.
    expect(
      githubChecksState({ state: 'pending', total_count: 0 }, [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('failing');
  });

  it('is failing when a commit status failed even if check runs are green', () => {
    expect(
      githubChecksState({ state: 'failure', total_count: 1 }, [
        { status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('failing');
  });

  it('is pending while any check run is still queued or in progress', () => {
    expect(
      githubChecksState({ state: 'pending', total_count: 0 }, [
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
      ]),
    ).toBe('pending');
    expect(
      githubChecksState({ state: 'pending', total_count: 0 }, [
        { status: 'queued', conclusion: null },
      ]),
    ).toBe('pending');
  });

  it('is pending on pending commit statuses with no failing signal', () => {
    expect(githubChecksState({ state: 'pending', total_count: 1 }, [])).toBe('pending');
  });

  it('counts neutral and skipped conclusions as ok', () => {
    expect(
      githubChecksState({ state: 'pending', total_count: 0 }, [
        { status: 'completed', conclusion: 'neutral' },
        { status: 'completed', conclusion: 'skipped' },
      ]),
    ).toBe('green');
  });

  it('counts cancelled, timed_out, and action_required as failing', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'action_required']) {
      expect(
        githubChecksState({ state: 'pending', total_count: 0 }, [
          { status: 'completed', conclusion },
        ]),
      ).toBe('failing');
    }
  });

  it('failing beats pending across both signals', () => {
    expect(
      githubChecksState({ state: 'pending', total_count: 1 }, [
        { status: 'completed', conclusion: 'failure' },
        { status: 'in_progress', conclusion: null },
      ]),
    ).toBe('failing');
  });
});
