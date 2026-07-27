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

  // Regression (observed live): a workflow that fails at STARTUP (an
  // invalid workflow file — e.g. a duplicated job key left by a bad
  // conflict resolution) completes with conclusion 'failure' but creates
  // ZERO jobs, hence zero check runs and zero commit statuses. With only
  // the first two signals the branch read green and red CI merged to main.
  describe('workflow-runs signal (Actions startup failures)', () => {
    it('is failing when a workflow run failed with no check runs and no statuses', () => {
      expect(
        githubChecksState({ state: 'pending', total_count: 0 }, [], [
          { workflow_id: 1, status: 'completed', conclusion: 'failure' },
        ]),
      ).toBe('failing');
    });

    it('counts startup_failure, cancelled and timed_out runs as failing', () => {
      for (const conclusion of ['startup_failure', 'cancelled', 'timed_out']) {
        expect(
          githubChecksState({ state: 'pending', total_count: 0 }, [], [
            { workflow_id: 1, status: 'completed', conclusion },
          ]),
        ).toBe('failing');
      }
    });

    it('is pending while a workflow run is in progress', () => {
      expect(
        githubChecksState({ state: 'pending', total_count: 0 }, [], [
          { workflow_id: 1, status: 'in_progress', conclusion: null },
        ]),
      ).toBe('pending');
    });

    it('stays green for a repo genuinely without CI (no signals at all)', () => {
      expect(githubChecksState({ state: 'pending', total_count: 0 }, [], [])).toBe('green');
    });

    it('a failed workflow run beats green check runs from another workflow', () => {
      expect(
        githubChecksState(
          { state: 'success', total_count: 1 },
          [{ status: 'completed', conclusion: 'success' }],
          [{ workflow_id: 2, status: 'completed', conclusion: 'failure' }],
        ),
      ).toBe('failing');
    });
  });
});
