// @vitest-environment jsdom
/**
 * Locking tests for the right-edge TaskStepsRail: it renders the ordered
 * implementation steps of the selected task as transparent vertical labels,
 * highlights the current step, and can be hidden/shown with the preference
 * persisted to localStorage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskStepsRail } from '@/components/TaskStepsRail';
import { TASK_STEPS } from '@/lib/task-steps';

afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

function stepItem(label: string): HTMLElement {
  return screen.getByText(label).closest('li') as HTMLElement;
}

describe('TaskStepsRail', () => {
  it('renders every implementation step as a vertical label', () => {
    render(<TaskStepsRail status="running" />);
    for (const step of TASK_STEPS) expect(screen.getByText(step.label)).toBeTruthy();
  });

  it('marks the step matching the status as the current step', () => {
    render(<TaskStepsRail status="running" />);
    expect(stepItem('Running').getAttribute('aria-current')).toBe('step');
    expect(stepItem('Running').dataset.tone).toBe('current');
    expect(stepItem('Proposal').dataset.tone).toBe('complete');
    expect(stepItem('Code review').dataset.tone).toBe('upcoming');
  });

  it('marks the failed step for a failed task', () => {
    render(<TaskStepsRail status="failed" />);
    expect(stepItem('Running').dataset.tone).toBe('failed');
  });

  it('hides the steps via the toggle and keeps a show handle', () => {
    render(<TaskStepsRail status="running" />);
    fireEvent.click(screen.getByRole('button', { name: /hide implementation steps/i }));
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByRole('button', { name: /show implementation steps/i })).toBeTruthy();
  });

  it('shows the steps again when the handle is clicked', () => {
    render(<TaskStepsRail status="running" />);
    fireEvent.click(screen.getByRole('button', { name: /hide implementation steps/i }));
    fireEvent.click(screen.getByRole('button', { name: /show implementation steps/i }));
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('persists the hidden preference across mounts', () => {
    // Non-running statuses keep respecting the persisted preference; a live
    // (running) status auto-opens the pane instead (covered below).
    const first = render(<TaskStepsRail status="done" />);
    fireEvent.click(screen.getByRole('button', { name: /hide implementation steps/i }));
    first.unmount();
    render(<TaskStepsRail status="done" />);
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByRole('button', { name: /show implementation steps/i })).toBeTruthy();
  });

  it('auto-opens the right-side steps pane for a running task even after the user hid it', () => {
    window.localStorage.setItem('lemniscate.task-steps-rail-hidden', 'true');
    render(<TaskStepsRail status="running" />);
    // A live (running/reviewing-code) task always opens with the pane shown.
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show implementation steps/i })).toBeNull();
  });

  it('auto-opens the right-side steps pane for a reviewing-code task', () => {
    window.localStorage.setItem('lemniscate.task-steps-rail-hidden', 'true');
    render(<TaskStepsRail status="reviewing_code" />);
    expect(screen.getByText('Code review')).toBeTruthy();
  });

  it('keeps the pane hidden for non-running tasks when the user hid it', () => {
    window.localStorage.setItem('lemniscate.task-steps-rail-hidden', 'true');
    render(<TaskStepsRail status="done" />);
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByRole('button', { name: /show implementation steps/i })).toBeTruthy();
  });
});
