import { describe, expect, it } from 'vitest';

import {
  formatDurationMs,
  formatTokens,
  headerStatusText,
  mergeAgentSteps,
  parseAgentStep,
  reduceAgentSteps,
  toolIcon,
  totalTokensUsed,
  type AgentStep,
} from '@/lib/agent-step';

const base = {
  stepId: 'step-1',
  status: 'running' as const,
  kind: 'tool' as const,
  title: 'read_file(a.ts)',
  tool: 'read_file',
};

describe('parseAgentStep', () => {
  it('parses a valid payload', () => {
    expect(parseAgentStep({ ...base, outputPreview: 'hi', durationMs: 12 }, 'ev-1')).toEqual({
      stepId: 'step-1',
      eventKey: 'ev-1',
      status: 'running',
      kind: 'tool',
      tool: 'read_file',
      title: 'read_file(a.ts)',
      outputPreview: 'hi',
      durationMs: 12,
    });
  });

  it('rejects incomplete or unknown shapes', () => {
    expect(parseAgentStep({})).toBeNull();
    expect(parseAgentStep({ ...base, status: 'nope' })).toBeNull();
    expect(parseAgentStep({ ...base, kind: 'system' })).toBeNull();
    expect(parseAgentStep(null)).toBeNull();
  });
});

describe('reduceAgentSteps', () => {
  it('keeps order and lets later events with the same stepId win', () => {
    const steps = reduceAgentSteps([
      { id: 'a', kind: 'log', payload: { line: 'x' } },
      {
        id: 'b',
        kind: 'agent_step',
        payload: { stepId: 's1', status: 'running', kind: 'tool', tool: 'bash', title: 'bash(ls)' },
      },
      {
        id: 'c',
        kind: 'agent_step',
        payload: {
          stepId: 's2',
          status: 'done',
          kind: 'assistant',
          title: 'Assistant turn 1',
          detail: 'ok',
          tokensUsed: 40,
        },
      },
      {
        id: 'd',
        kind: 'agent_step',
        payload: {
          stepId: 's1',
          status: 'done',
          kind: 'tool',
          tool: 'bash',
          title: 'bash(ls)',
          outputPreview: 'a.ts',
          durationMs: 5,
        },
      },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ stepId: 's1', status: 'done', outputPreview: 'a.ts' });
    expect(steps[1]).toMatchObject({ stepId: 's2', kind: 'assistant', tokensUsed: 40 });
  });
});

describe('mergeAgentSteps', () => {
  it('appends new live steps and overrides history on the same id', () => {
    const history: AgentStep[] = [
      {
        stepId: 's1',
        eventKey: 'h1',
        status: 'running',
        kind: 'tool',
        tool: 'grep',
        title: 'grep x',
      },
    ];
    const live: AgentStep[] = [
      {
        stepId: 's1',
        eventKey: 'l1',
        status: 'done',
        kind: 'tool',
        tool: 'grep',
        title: 'grep x',
        durationMs: 9,
      },
      {
        stepId: 's2',
        eventKey: 'l2',
        status: 'running',
        kind: 'assistant',
        title: 'turn 2',
      },
    ];
    const merged = mergeAgentSteps(history, live);
    expect(merged.map((s) => s.stepId)).toEqual(['s1', 's2']);
    expect(merged[0]?.status).toBe('done');
    expect(merged[0]?.durationMs).toBe(9);
  });
});

describe('display helpers', () => {
  it('maps tool icons and formats durations/tokens', () => {
    expect(toolIcon('read_file')).toBe('📖');
    expect(toolIcon('web_search')).toBe('🌐');
    expect(toolIcon(undefined)).toBe('💬');
    expect(formatDurationMs(120)).toBe('120ms');
    expect(formatDurationMs(1500)).toBe('1.5s');
    expect(formatTokens(420)).toBe('420');
    expect(formatTokens(12_500)).toBe('13k');
  });

  it('builds header status from the latest step', () => {
    const steps: AgentStep[] = [
      {
        stepId: '1',
        eventKey: '1',
        status: 'done',
        kind: 'assistant',
        title: 'turn 1',
        tokensUsed: 10,
      },
      {
        stepId: '2',
        eventKey: '2',
        status: 'running',
        kind: 'tool',
        tool: 'bash',
        title: 'bash(test)',
      },
    ];
    expect(headerStatusText(steps, true)).toBe('Running bash');
    expect(headerStatusText([], true)).toBe('Starting…');
    expect(headerStatusText([{ ...steps[0]!, status: 'done' }], false)).toBe('Done');
    expect(totalTokensUsed(steps)).toBe(10);
  });
});
