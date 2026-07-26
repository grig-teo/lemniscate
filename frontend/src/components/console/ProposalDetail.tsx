import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/MarkdownView";
import { apiFetch } from "@/lib/api";

export interface ProposalTask {
  id: string;
  title?: string | null;
  description?: string | null;
}

interface ProposalDetailProps {
  task: ProposalTask;
  onUpdated?: (task: ProposalTask) => void;
}

export function ProposalDetail({ task, onUpdated }: ProposalDetailProps) {
  const [title, setTitle] = useState(task.title ?? "");
  const [description, setDescription] = useState(task.description ?? "");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [improving, setImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function improve() {
    setImproving(true);
    setError(null);
    try {
      const result = await apiFetch<{ description: string }>(
        `/api/tasks/${task.id}/improve-description`,
        {
          method: "POST",
          body: JSON.stringify({
            title: title?.trim() || undefined,
            description,
          }),
        },
      );
      setDescription(result.description);
      onUpdated?.({ ...task, title: title || null, description: result.description });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to improve description");
    } finally {
      setImproving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant={mode === "preview" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("preview")}
        >
          Preview
        </Button>
        <Button
          variant={mode === "edit" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("edit")}
        >
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={improve}
          disabled={improving || !description.trim()}
        >
          <Sparkles className="mr-1 h-4 w-4" />
          {improving ? "Improving…" : "Improve"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {mode === "edit" ? (
        <div className="flex flex-col gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the task…"
            rows={8}
          />
        </div>
      ) : (
        <div className="rounded-md border p-3">
          {title && <h3 className="mb-2 font-medium">{title}</h3>}
          <MarkdownView content={description || "_No description yet._"} />
        </div>
      )}
    </div>
  );
}
