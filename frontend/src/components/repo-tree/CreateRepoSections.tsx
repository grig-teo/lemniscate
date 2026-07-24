import * as React from 'react';
import { FolderTree } from 'lucide-react';

import { previewStructure } from '@/lib/library';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * First-prompt section of the create-repository dialog: the project
 * description textarea plus the structure preview. The previewed folders
 * feed the shared LibraryAttachments AGENTS.md rows via the onFolders
 * callback; everything else (skills, MCP, AGENTS.md pickers) is rendered by
 * components/library/LibraryAttachments.tsx.
 */

const PREVIEW_MIN_CHARS = 20;

export function useInitProject(onFolders?: (folders: string[]) => void) {
  const [prompt, setPrompt] = React.useState('');
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewed, setPreviewed] = React.useState(false);

  const runPreview = async () => {
    if (prompt.trim().length < 3 || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const folders = await previewStructure(prompt.trim());
      setPreviewed(true);
      onFolders?.(folders);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Structure preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  // Auto-preview once when the field loses focus with a meaningful prompt.
  const onPromptBlur = () => {
    if (!previewed && prompt.trim().length >= PREVIEW_MIN_CHARS) {
      void runPreview();
    }
  };

  const reset = () => {
    setPrompt('');
    setPreviewing(false);
    setPreviewError(null);
    setPreviewed(false);
  };

  return { prompt, setPrompt, onPromptBlur, previewing, previewError, runPreview, reset };
}

export function InitPromptSection({ init }: { init: ReturnType<typeof useInitProject> }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        First prompt — describes the project, runs as the first task
      </span>
      <Textarea
        value={init.prompt}
        onChange={(event) => init.setPrompt(event.target.value)}
        onBlur={init.onPromptBlur}
        placeholder="e.g. A Next.js shop with a product catalog, cart and Stripe checkout"
        rows={3}
        className="min-w-0"
        aria-label="First prompt"
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={init.prompt.trim().length < 3 || init.previewing}
          onClick={() => void init.runPreview()}
        >
          <FolderTree className="mr-1.5 h-4 w-4" aria-hidden />
          {init.previewing ? 'Previewing…' : 'Preview structure'}
        </Button>
        {init.previewError && <span className="text-xs text-destructive">{init.previewError}</span>}
      </div>
    </section>
  );
}
