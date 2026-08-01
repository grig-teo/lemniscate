import { useDeleteRepository, type Repository } from '@/lib/hooks';
import { repoDisplayName } from '@/lib/repo-display';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Clears center-pane selections that point at the deleted repository. */
function useClearDeletedRepoSelection(repoId: string) {
  const selection = useWorkspaceSelection();
  return () => {
    if (selection.selectedRepositoryId === repoId) selection.selectRepository(null);
    if (selection.prReviewRepoId === repoId) selection.closePrReview();
    if (selection.taskBoardRepoId === repoId) selection.closeTaskBoard();
    if (selection.archivedRepoId === repoId) selection.closeArchived();
  };
}

/**
 * "Do you really want to delete this repository?" confirmation with Yes/No
 * buttons. Yes deletes the repository via the API (remote repo on the git
 * provider is untouched); No simply closes the dialog.
 */
export function DeleteRepoDialog({
  repo,
  open,
  onClose,
}: {
  repo: Repository;
  open: boolean;
  onClose: () => void;
}) {
  const deleteRepo = useDeleteRepository();
  const clearSelection = useClearDeletedRepoSelection(repo.id);
  const confirm = () =>
    deleteRepo.mutate(repo.id, {
      onSuccess: () => {
        clearSelection();
        onClose();
      },
    });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-label={`Delete repository ${repo.fullName}`}>
        <DialogHeader>
          <DialogTitle>Delete repository</DialogTitle>
          <DialogDescription>
            Do you really want to delete the repository &quot;{repoDisplayName(repo)}&quot;? This
            removes it together with its tasks and settings. The repository on the git provider is
            not touched. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {deleteRepo.isError && (
          <p role="alert" className="text-sm text-destructive">
            {deleteRepo.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleteRepo.isPending}>
            No
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleteRepo.isPending}>
            {deleteRepo.isPending ? 'Deleting…' : 'Yes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
