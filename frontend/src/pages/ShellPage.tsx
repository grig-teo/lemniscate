import { ConsolePane } from '@/components/ConsolePane';
import { RepoTree } from '@/components/RepoTree';
import { TopNav } from '@/components/TopNav';
import { WorkspaceSelectionProvider } from '@/lib/selection';
import { useResizableSidebar } from '@/lib/use-resizable-sidebar';

/**
 * Main application shell: top nav + two-pane layout
 * (repos sidebar | agent console).
 *
 * The panes share task selection and live status via
 * WorkspaceSelectionProvider (see src/lib/selection.ts).
 */
export function ShellPage() {
  const { width, startDrag } = useResizableSidebar();

  return (
    <WorkspaceSelectionProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopNav />
        <div className="flex min-h-0 flex-1">
          <RepoTree width={width} />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={startDrag}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent"
          />
          <ConsolePane />
        </div>
      </div>
    </WorkspaceSelectionProvider>
  );
}
