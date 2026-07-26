import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  measureJob,
  metricsRegistry,
  pollQueueMetrics,
  recordJobFailureMetric,
  recordLlmCall,
  renderMetrics,
  startQueueMetricsPoller,
  updateQueueGauges,
} from '../src/lib/metrics.js';

// Prometheus metrics: one registry (lib/metrics.ts) feeding both the worker
// :3100/metrics and the token-guarded API /metrics. Labels stay bounded —
// job name, error kind, model — never taskId/userId.

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe('updateQueueGauges', () => {
  it('sets one gauge per known queue state, defaulting missing states to 0', async () => {
    updateQueueGauges('agent-tasks', { waiting: 3, active: 1 });

    const text = await renderMetrics();
    expect(text).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="waiting"} 3');
    expect(text).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="active"} 1');
    expect(text).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="failed"} 0');
  });
});

describe('measureJob', () => {
  it('returns the job result and records a completed outcome with duration', async () => {
    const result = await measureJob('run-task', async () => 'done');

    expect(result).toBe('done');
    const text = await renderMetrics();
    expect(text).toContain('lemniscate_jobs_total{job_name="run-task",outcome="completed"} 1');
    expect(text).toContain('lemniscate_job_duration_seconds_count{job_name="run-task"} 1');
  });

  it('rethrows the error and records a failed outcome', async () => {
    const boom = new Error('boom');

    await expect(
      measureJob('review-pr', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const text = await renderMetrics();
    expect(text).toContain('lemniscate_jobs_total{job_name="review-pr",outcome="failed"} 1');
    expect(text).toContain('lemniscate_job_duration_seconds_count{job_name="review-pr"} 1');
  });
});

describe('recordJobFailureMetric', () => {
  it('increments the failure counter labeled by job name and error kind', async () => {
    recordJobFailureMetric({ jobName: 'run-task', errorKind: 'LlmError' });
    recordJobFailureMetric({ jobName: 'run-task', errorKind: 'LlmError' });
    recordJobFailureMetric({ jobName: 'run-task', errorKind: 'Error' });

    const text = await renderMetrics();
    expect(text).toContain(
      'lemniscate_job_failures_total{job_name="run-task",error_kind="LlmError"} 2',
    );
    expect(text).toContain(
      'lemniscate_job_failures_total{job_name="run-task",error_kind="Error"} 1',
    );
  });
});

describe('recordLlmCall', () => {
  it('counts the request, observes latency, and adds prompt/completion tokens', async () => {
    recordLlmCall({
      model: 'gpt-x',
      status: 'ok',
      latencyMs: 1500,
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const text = await renderMetrics();
    expect(text).toContain('lemniscate_llm_requests_total{model="gpt-x",status="ok"} 1');
    expect(text).toContain('lemniscate_llm_request_duration_seconds_count{model="gpt-x"} 1');
    expect(text).toContain('lemniscate_llm_request_duration_seconds_sum{model="gpt-x"} 1.5');
    expect(text).toContain('lemniscate_llm_tokens_total{model="gpt-x",kind="prompt"} 10');
    expect(text).toContain('lemniscate_llm_tokens_total{model="gpt-x",kind="completion"} 5');
  });

  it('skips token counters when the provider returned no usage', async () => {
    recordLlmCall({ model: 'local', status: 'ok', latencyMs: 10 });

    const text = await renderMetrics();
    expect(text).toContain('lemniscate_llm_requests_total{model="local",status="ok"} 1');
    expect(text).not.toContain('lemniscate_llm_tokens_total{');
  });
});

describe('pollQueueMetrics', () => {
  it('copies a queue snapshot into the gauges', async () => {
    await pollQueueMetrics(async () => ({ queue: 'agent-tasks', counts: { waiting: 7 } }));

    const text = await renderMetrics();
    expect(text).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="waiting"} 7');
  });

  it('keeps the previous values when the snapshot read fails', async () => {
    updateQueueGauges('agent-tasks', { waiting: 4 });

    await pollQueueMetrics(async () => {
      throw new Error('redis down');
    });
    const text = await renderMetrics();
    expect(text).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="waiting"} 4');
  });
});

describe('startQueueMetricsPoller', () => {
  it('polls immediately and on the interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const stop = startQueueMetricsPoller(async () => {
        reads += 1;
        return { queue: 'q', counts: { waiting: reads } };
      }, 1000);

      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(reads).toBe(4);
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(reads).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
