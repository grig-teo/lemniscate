/**
 * Bottom toolbar of the pending-task (proposal / saved-for-later) editor: the
 * left-aligned pending-task controls (per-task model override + the manual
 * follow-up chaining select) and the PR-close button when reviewing, with the
 * right-aligned attach / autosave-status / Start controls. Extracted from
 * ProposalDetail.tsx to keep that module under the 300-line AGENTS.md section 2
 * limit once the follow-up task control was added.
 *
 * All of the toolbar's data lives in the parent (TaskEditorInner), which owns
 * the autosave + start/improve/close mutations; this is a thin presentational
 * layer that wires the chosen values/handlers to the shared controls
 * (§6: one parameterized control per concept, reused from the composer).
 */
import { Hammer, Loader2, Paperclip, GitPullRequestClosed } from 'lucide-react';

import type { Task } from '@/lib/hooks';
import type { TaskImage } from '@/lib/hooks';
import type { AutosaveStatus } from '@/lib/use-autosave';
import { IMAGE_ACCEPT, MAX_IMAGES } from '@/lib/prompt-composer';
import { Button } from '@/components/ui/button';
import { AttachFileButton } from '@/components/console/TaskEditorFields';
import { SaveStatusIndicator } from '@/components/console/SaveStatusIndicator';
import { PendingTaskModelSelect } from '@/components/console/PendingTaskModelSelect';
import { FollowUpTaskSelect } from '@/components/console/TaskComposerControls';

export function ProposalDetailActionBar({
  task,
  followUpTaskId,
  onFollowUpTaskIdChange,
  images,
  onAttachFiles,
  startPending,
  onStart,
  closePrPending,
  onClosePr,
  autosaveStatus,
  onRetrySave,
}: {
  task: Task;
  followUpTaskId: string | null;
  onFollowUpTaskIdChange: (id: string | null) => void;
  images: TaskImage[];
  onAttachFiles: (files: FileList | null) => void;
  startPending: boolean;
  onStart: () => void;
  closePrPending: boolean;
  onClosePr: () => void;
  autosaveStatus: AutosaveStatus;
  onRetrySave: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {task.status === 'pending' && (
        <>
          <PendingTaskModelSelect task={task} />
          <FollowUpTaskSelect
            repositoryId={task.repositoryId}
            selfId={task.id}
            value={followUpTaskId}
            onChange={onFollowUpTaskIdChange}
          />
        </>
      )}
      {(task.status === 'awaiting_review' || task.status === 'reviewing_code') && task.branchName && (
        <Button
          size="sm"
          variant="destructive"
          onClick={onClosePr}
          disabled={closePrPending}
          aria-label="Close PR and delete branch"
        >
          {closePrPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <GitPullRequestClosed className="h-4 w-4" aria-hidden />
          )}
          Close PR
        </Button>
      )}
      <div className="flex-1" />
      <AttachFileButton
        accept={IMAGE_ACCEPT}
        label="Attach file"
        icon={Paperclip}
        disabled={images.length >= MAX_IMAGES}
        onFiles={onAttachFiles}
      />
      <SaveStatusIndicator status={autosaveStatus} onRetry={onRetrySave} />
      <Button size="sm" onClick={onStart} disabled={startPending} aria-label="Start task">
        {startPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Hammer className="h-4 w-4" aria-hidden />
        )}
        Start
      </Button>
    </div>
  );
}
