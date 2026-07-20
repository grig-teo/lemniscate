import { ConsolePane } from '@/components/ConsolePane';
import { DiffPanel } from '@/components/DiffPanel';
import { RepoTree } from '@/components/RepoTree';
import { TopNav } from '@/components/TopNav';
import { WorkspaceSelectionProvider } from '@/lib/selection';

/**
 * Main application shell: top nav + three-pane layout
 * (repos sidebar | agent console | code/diff panel).
 *
 * The three panes share task selection, live status, and diff events via
 * WorkspaceSelectionProvider (see src/lib/selection.ts).
 */
export function ShellPage() {
  return (
    <WorkspaceSelectionProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopNav />
        <div className="flex min-h-0 flex-1">
          <RepoTree />
          <ConsolePane />
          <DiffPanel />
        </div>
      </div>
    </WorkspaceSelectionProvider>
  );
}
