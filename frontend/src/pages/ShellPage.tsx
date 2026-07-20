import { ConsolePane } from '@/components/ConsolePane';
import { RepoTree } from '@/components/RepoTree';
import { TopNav } from '@/components/TopNav';
import { WorkspaceSelectionProvider } from '@/lib/selection';

/**
 * Main application shell: top nav + two-pane layout
 * (repos sidebar | agent console).
 *
 * The panes share task selection and live status via
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
        </div>
      </div>
    </WorkspaceSelectionProvider>
  );
}
