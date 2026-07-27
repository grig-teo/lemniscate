import type { EventTriggerKind } from '@/lib/hooks';

const EVENT_KIND_LABELS: Record<EventTriggerKind, string> = {
  ci_failed: 'CI failed',
  issue_opened: 'Issue opened',
};

export const EVENT_KIND_DESCRIPTIONS: Record<EventTriggerKind, string> = {
  ci_failed: 'A CI check run / pipeline fails on the default branch.',
  issue_opened: 'A new issue is opened on the repository.',
};

export function eventKindLabel(kind: EventTriggerKind): string {
  return EVENT_KIND_LABELS[kind];
}

/** Kinds still available for a new trigger (one per kind per repository). */
export function availableKinds(usedKinds: EventTriggerKind[]): EventTriggerKind[] {
  return (Object.keys(EVENT_KIND_LABELS) as EventTriggerKind[]).filter(
    (kind) => !usedKinds.includes(kind),
  );
}
