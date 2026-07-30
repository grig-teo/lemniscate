// Adapter ports between the platform-agnostic @lemniscate/core loop and the
// host (the Lemniscate backend, or the standalone CLI). The backend wires
// these to its DB/Redis/OpenAI-compatible client; the CLI wires them to env
// vars + stdout. No platform imports may appear in the package — every
// side effect goes through one of these interfaces.

import type {
  CoreChatRequest,
  CoreChatResponse,
  CoreStep,
  CoreToolResult,
  CoreToolSpec,
} from './core-types.js';

/** LLM call port. The host implements retries/throttling/budget accounting. */
export interface ChatPort {
  chat(req: CoreChatRequest): Promise<CoreChatResponse>;
}

/** Step-event sink. Parent loop events stream here (publishTaskEvent in the
 * backend, stderr/stdout in the CLI). */
export type EventSink = (step: CoreStep) => void | Promise<void>;

export interface ToolContext {
  workdir: string;
  secrets: string[];
}

/** Registry-driven tool (Phase 9 SDK shape): name + JSON-schema + runner. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object for the function parameters (OpenAI tool format). */
  schema: Record<string, unknown>;
  /** Mutating tools are approval-gated when the host enables it. */
  mutating: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<CoreToolResult>;
}

export interface ToolProvider {
  /** Tool schemas offered to the model for this run. */
  list(): CoreToolSpec[];
  /** Execute a call the model made. Unknown names must return an error
   * result (not throw) so the model can correct itself. */
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CoreToolResult>;
}

/** Read-only tools auto-approved even when approvals are required. */
export interface ApprovalPort {
  requireApproval(name: string): boolean;
  /** Publish the awaiting_approval step and block until the host records a
   * decision. Returns null on timeout. */
  wait(name: string, step: CoreStep): Promise<'approve' | 'deny' | null>;
}

/** Optional persistence hooks so hosts can resume/compact transcripts. */
export interface TranscriptStore {
  save(messages: CoreChatMessage[]): void;
}

/** Skill content resolution for load_skill (progressive disclosure). */
export type SkillProvider = (name: string) => Promise<{ name: string; content: string } | null>;

export interface SpawnSubagentRequest {
  task: string;
  workdir?: string;
  /** Tool-call/step correlation id assigned by the runner. */
  stepId: string;
}

/** Backend host port for the depth-1 subagent run (tool stays out of the
 * standalone CLI). */
export type SubagentRunner = (req: SpawnSubagentRequest) => Promise<string>;
