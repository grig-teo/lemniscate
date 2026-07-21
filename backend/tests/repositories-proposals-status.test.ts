import { describe, expect, it } from 'vitest';
import { isGeneratingProposals } from '../src/routes/repositories.js';

// Locking tests for the pure helper behind GET /repositories/:id/proposals/status:
// a generate-proposals job for this repository in an active/waiting/delayed
// state means generation is in flight.

const job = (name: string, data?: unknown) => ({ name, data });

describe('isGeneratingProposals', () => {
  it('is true when a generate-proposals job targets the repository', () => {
    const jobs = [job('generate-proposals', { repositoryId: 'repo-1' })];
    expect(isGeneratingProposals(jobs, 'repo-1')).toBe(true);
  });

  it('is true regardless of where the matching job sits in the list', () => {
    const jobs = [
      job('run-task', { taskId: 'task-1' }),
      job('generate-proposals', { repositoryId: 'repo-1' }),
    ];
    expect(isGeneratingProposals(jobs, 'repo-1')).toBe(true);
  });

  it('is false when the only generate-proposals jobs target other repositories', () => {
    const jobs = [job('generate-proposals', { repositoryId: 'repo-2' })];
    expect(isGeneratingProposals(jobs, 'repo-1')).toBe(false);
  });

  it('is false when jobs for the repository have other names', () => {
    const jobs = [
      job('run-task', { repositoryId: 'repo-1' }),
      job('review-pr', { repositoryId: 'repo-1' }),
    ];
    expect(isGeneratingProposals(jobs, 'repo-1')).toBe(false);
  });

  it('tolerates jobs with missing or non-object data', () => {
    const jobs = [job('generate-proposals'), job('generate-proposals', null), job('run-task')];
    expect(isGeneratingProposals(jobs, 'repo-1')).toBe(false);
  });

  it('is false for an empty job list', () => {
    expect(isGeneratingProposals([], 'repo-1')).toBe(false);
  });
});
