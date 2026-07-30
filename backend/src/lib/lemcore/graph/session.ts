// In-memory graph session keyed by workdir. Lemcore scan stores the graph
// here so implementation tools can query it without rebuilding.

import type { GraphSession, LemcoreCodebaseGraph } from './types.js';

const sessions = new Map<string, GraphSession>();

export function graphSessionKey(workdir: string): string {
  return workdir.replace(/[/\\]+$/, '');
}

export function storeGraphSession(
  workdir: string,
  graph: LemcoreCodebaseGraph,
  maxDepth = graph.maxDepth ?? 2,
): GraphSession {
  const session: GraphSession = { graph, maxDepth };
  sessions.set(graphSessionKey(workdir), session);
  return session;
}

export function getGraphSession(workdir: string): GraphSession | null {
  return sessions.get(graphSessionKey(workdir)) ?? null;
}

export function clearGraphSession(workdir: string): void {
  sessions.delete(graphSessionKey(workdir));
}

/** Test helper — drop all sessions. */
export function resetGraphSessions(): void {
  sessions.clear();
}
