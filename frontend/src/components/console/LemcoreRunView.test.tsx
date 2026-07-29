// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LemcoreRunView } from '@/components/console/LemcoreRunView';
import type { AgentStep } from '@/lib/agent-step';

afterEach(() => cleanup());

const steps: AgentStep[] = [
  {
    stepId: 'a1',
    eventKey: 'e1',
    status: 'done',
    kind: 'assistant',
    title: 'Assistant turn 1',
    detail: 'I will read the file.',
    durationMs: 100,
    tokensUsed: 20,
  },
  {
    stepId: 't1',
    eventKey: 'e2',
    status: 'done',
    kind: 'tool',
    tool: 'read_file',
    title: 'read_file(src/a.ts)',
    outputPreview: 'export const x = 1;',
    durationMs: 12,
  },
  {
    stepId: 't2',
    eventKey: 'e3',
    status: 'running',
    kind: 'tool',
    tool: 'bash',
    title: 'bash(npm test)',
  },
];

describe('LemcoreRunView', () => {
  it('renders sticky header status and step cards', () => {
    render(
      <LemcoreRunView
        steps={steps}
        running
        streamError={false}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText('Running bash')).toBeTruthy();
    expect(screen.getByText('Assistant turn 1')).toBeTruthy();
    expect(screen.getByText('read_file(src/a.ts)')).toBeTruthy();
    expect(screen.getByText('bash(npm test)')).toBeTruthy();
    expect(screen.getByTestId('lemcore-run-view')).toBeTruthy();
  });

  it('expands tool output on demand', () => {
    render(
      <LemcoreRunView
        steps={steps}
        running={false}
        streamError={false}
        isLoading={false}
        isError={false}
      />,
    );
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('export const x = 1;')).toBeTruthy();
  });

  it('shows empty waiting state', () => {
    render(
      <LemcoreRunView
        steps={[]}
        running
        streamError={false}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText(/Waiting for lemcore agent steps/i)).toBeTruthy();
  });
});
