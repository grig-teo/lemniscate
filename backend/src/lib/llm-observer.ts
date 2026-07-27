// Observability hook for the LLM client: exactly one process-wide observer
// (registered by lib/metrics.ts) receives the final outcome of every
// chatCompletions call. Kept as a setter (not a param) so the many call sites
// stay unchanged and the client module stays free of any metrics dependency.
//
// Split out of llm-client.ts to keep that module under the 300-line guard
// baseline (AGENTS.md section 2); llm-client re-exports the public surface.

import type { LlmError } from './llm-client.js';

export type LlmOutcome = 'success' | LlmError['kind'];

export interface LlmRequestObservation {
  outcome: LlmOutcome;
  latencyMs: number;
}

let llmObserver: ((obs: LlmRequestObservation) => void) | undefined;

export function setLlmObserver(
  observer: ((obs: LlmRequestObservation) => void) | undefined,
): void {
  llmObserver = observer;
}

export function notifyObserver(outcome: LlmOutcome, startedAt: number): void {
  llmObserver?.({ outcome, latencyMs: Date.now() - startedAt });
}
