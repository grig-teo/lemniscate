import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Upload } from 'lucide-react';

import { api, describeApiError } from '@/lib/api';
import type { LibraryItem } from '@/lib/library';
import { buildMcpConfig, parseSkillMarkdown, slugify } from '@/lib/library-upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Inline create forms rendered inside the skills / MCP pickers when a search
 * finds nothing: upload a SKILL.md (skills) or fill in a minimal stdio
 * config (MCP servers). On success the entry is reported via onCreated so
 * the picker can select it immediately.
 */

function useCreateSkill(onCreated: (item: LibraryItem) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ skill: LibraryItem }>('/api/skills', body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      onCreated(data.skill);
    },
  });
}

function useCreateMcpServer(onCreated: (item: LibraryItem) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ server: LibraryItem }>('/api/mcp-servers', body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      onCreated(data.server);
    },
  });
}

function FormError({ error }: { error: Error | null }) {
  if (!error) return null;
  return <p className="px-1 text-xs text-destructive">{describeApiError(error)}</p>;
}

/** Upload-a-SKILL.md form shown when a skill search matches nothing. */
export function SkillUploadEntry({ onCreated }: { onCreated: (item: LibraryItem) => void }) {
  const createSkill = useCreateSkill(onCreated);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const parsed = parseSkillMarkdown(file.name, await file.text());
    createSkill.mutate({
      slug: parsed.slug,
      name: parsed.name,
      category: 'custom',
      description: parsed.description,
      content: parsed.content,
      tags: [],
      kind: 'skill',
    });
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <p className="text-xs text-muted-foreground">Nothing matches — upload a skill (.md):</p>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.txt,text/markdown,text/plain"
        aria-label="Upload skill file"
        className="hidden"
        onChange={(event) => void handleFile(event)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 self-start"
        disabled={createSkill.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {createSkill.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Upload className="h-3.5 w-3.5" aria-hidden />
        )}
        Upload skill
      </Button>
      <FormError error={createSkill.error} />
    </div>
  );
}

/** Minimal stdio-config form shown when an MCP server search matches nothing. */
export function McpCreateEntry({ onCreated }: { onCreated: (item: LibraryItem) => void }) {
  const createServer = useCreateMcpServer(onCreated);
  const [name, setName] = React.useState('');
  const [command, setCommand] = React.useState('');
  const [args, setArgs] = React.useState('');
  const [env, setEnv] = React.useState('');

  const canSubmit = name.trim() !== '' && command.trim() !== '' && !createServer.isPending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    createServer.mutate({
      slug: slugify(name),
      name: name.trim(),
      description: '',
      config: buildMcpConfig({ command, args, env }),
      tags: [],
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 px-2 py-2">
      <p className="text-xs text-muted-foreground">Nothing matches — add an MCP server:</p>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name, e.g. brave-search"
        aria-label="MCP server name"
        className="h-8 text-xs"
        required
      />
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder="Command, e.g. npx"
        aria-label="MCP server command"
        className="h-8 text-xs"
        required
      />
      <Input
        value={args}
        onChange={(event) => setArgs(event.target.value)}
        placeholder="Args, e.g. -y @modelcontextprotocol/server-brave-search"
        aria-label="MCP server args"
        className="h-8 text-xs"
      />
      <Textarea
        value={env}
        onChange={(event) => setEnv(event.target.value)}
        placeholder="Env (optional), KEY=VALUE per line"
        aria-label="MCP server env"
        rows={2}
        className="text-xs"
      />
      <Button type="submit" size="sm" variant="outline" className="h-8 gap-1.5 self-start" disabled={!canSubmit}>
        {createServer.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Plus className="h-3.5 w-3.5" aria-hidden />
        )}
        Add server
      </Button>
      <FormError error={createServer.error} />
    </form>
  );
}
