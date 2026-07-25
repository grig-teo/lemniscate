import * as React from 'react';
import { Eye } from 'lucide-react';

import { useMe, useSkill, useUpdateSkill, type SkillDetail } from '@/lib/hooks';
import { canEditSkill } from '@/lib/skills';
import { MarkdownView } from '@/components/MarkdownView';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

/**
 * Read-only markdown preview of a skills-library entry (kind 'skill' or
 * 'agents_md'). Entries owned by the current user get an Edit mode that saves
 * via PUT /api/skills/:slug; global entries show a read-only note.
 */

function SkillEditor({
  skill,
  onCancel,
  onSaved,
}: {
  skill: SkillDetail;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = React.useState(skill.content);
  const updateSkill = useUpdateSkill();
  const save = () =>
    updateSkill.mutate({ slug: skill.slug, patch: { content: draft } }, { onSuccess: onSaved });
  return (
    <>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Skill content"
        className="max-h-[60vh] min-h-64 font-mono text-xs"
      />
      {updateSkill.isError && (
        <p className="text-sm text-destructive">{updateSkill.error.message}</p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={updateSkill.isPending}>
          Cancel
        </Button>
        <Button onClick={save} disabled={updateSkill.isPending || !draft.trim()}>
          {updateSkill.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}

function SkillPreview({
  skill,
  editable,
  onEdit,
}: {
  skill: SkillDetail;
  editable: boolean;
  onEdit: () => void;
}) {
  return (
    <>
      <div className="max-h-[60vh] min-h-32 overflow-y-auto rounded-md border p-3">
        <MarkdownView>{skill.content}</MarkdownView>
      </div>
      {editable ? (
        <DialogFooter>
          <Button variant="outline" onClick={onEdit}>
            Edit
          </Button>
        </DialogFooter>
      ) : (
        <p className="text-xs text-muted-foreground">Global library entry — read-only</p>
      )}
    </>
  );
}

function SkillPreviewContent({ slug }: { slug: string }) {
  const skillQuery = useSkill(slug);
  const meQuery = useMe();
  const [editing, setEditing] = React.useState(false);
  if (skillQuery.isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  const skill = skillQuery.data;
  if (!skill) {
    return <p className="py-8 text-center text-sm text-destructive">Failed to load this entry.</p>;
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{skill.name}</DialogTitle>
        <DialogDescription className="break-words">
          {skill.category} · {skill.slug}
          {skill.kind === 'agents_md' ? ' · AGENTS.md template' : ''}
        </DialogDescription>
      </DialogHeader>
      {editing ? (
        <SkillEditor skill={skill} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />
      ) : (
        <SkillPreview
          skill={skill}
          editable={canEditSkill(skill, meQuery.data?.id)}
          onEdit={() => setEditing(true)}
        />
      )}
    </>
  );
}

export function SkillPreviewDialog({
  slug,
  onClose,
}: {
  slug: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={slug !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="overflow-hidden sm:max-w-2xl">
        {slug !== null && <SkillPreviewContent key={slug} slug={slug} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Eye icon-button that opens the preview dialog for one entry — self-contained
 * (owns its open state), usable inside pickers and rows. Clicks are stopped so
 * the surrounding row/label never toggles its own selection.
 */
export function SkillPreviewButton({ slug }: { slug: string }) {
  const [previewSlug, setPreviewSlug] = React.useState<string | null>(null);
  const openPreview = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setPreviewSlug(slug);
  };
  return (
    <>
      <button
        type="button"
        aria-label="Preview"
        onClick={openPreview}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
      </button>
      <SkillPreviewDialog slug={previewSlug} onClose={() => setPreviewSlug(null)} />
    </>
  );
}
