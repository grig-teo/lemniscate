/** Muted caption above each library-attachment section (shared by the editors). */
import type { ReactNode } from 'react';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}
