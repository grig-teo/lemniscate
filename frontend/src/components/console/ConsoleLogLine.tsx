/**
 * Renders one classified agent console log line as a structured UI row
 * (icon + styled content) instead of raw monospace text. The classification
 * itself lives in lib/console-log-line.ts; this component is display-only.
 */
import {
  AlertTriangle,
  CheckCircle2,
  FileDiff,
  FilePlus2,
  FileX2,
  Info,
  Sparkles,
  Terminal,
} from 'lucide-react';

import { classifyConsoleLog, type ConsoleLogRow } from '@/lib/console-log-line';
import { formatTokens } from '@/lib/token-usage';
import { cn } from '@/lib/utils';

function Row({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={cn('mt-0.5 shrink-0', tone)} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function CommandRow({ text }: { text: string }) {
  return (
    <Row icon={<Terminal className="h-3.5 w-3.5" />} tone="text-zinc-400 dark:text-zinc-500">
      <code className="block whitespace-pre-wrap break-all rounded-md border border-zinc-200 bg-zinc-100/80 px-2 py-1 font-mono text-[11px] leading-4 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        $ {text}
      </code>
    </Row>
  );
}

function LlmStartRow({ model }: { model: string }) {
  return (
    <Row icon={<Sparkles className="h-3.5 w-3.5" />} tone="text-sky-600 dark:text-sky-400">
      <span className="text-xs text-zinc-700 dark:text-zinc-300">
        Calling the model{' '}
        <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300">
          {model}
        </span>
      </span>
    </Row>
  );
}

function LlmDoneRow({ seconds, tokens }: { seconds: string; tokens: number }) {
  return (
    <Row
      icon={<CheckCircle2 className="h-3.5 w-3.5" />}
      tone="text-emerald-600 dark:text-emerald-400"
    >
      <span className="text-xs text-zinc-600 dark:text-zinc-400">
        Model responded in {seconds}s · ~{formatTokens(tokens)} tokens
      </span>
    </Row>
  );
}

function NoticeRow({ text, label }: { text: string; label: string }) {
  return (
    <Row
      icon={<AlertTriangle className="h-3.5 w-3.5" />}
      tone="text-amber-600 dark:text-amber-400"
    >
      <span className="text-xs text-amber-700 dark:text-amber-300">
        <span className="mr-1 font-medium">{label}</span>
        {text}
      </span>
    </Row>
  );
}

function ErrorRow({ text }: { text: string }) {
  return (
    <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} tone="text-red-600 dark:text-red-400">
      <span className="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {text}
      </span>
    </Row>
  );
}

const FILE_ICONS = {
  created: <FilePlus2 className="h-3.5 w-3.5" />,
  deleted: <FileX2 className="h-3.5 w-3.5" />,
  modified: <FileDiff className="h-3.5 w-3.5" />,
} as const;

const FILE_TONES = {
  created: 'text-emerald-600 dark:text-emerald-400',
  deleted: 'text-red-600 dark:text-red-400',
  modified: 'text-sky-600 dark:text-sky-400',
} as const;

function FileRow({ path, action }: { path: string; action: keyof typeof FILE_ICONS }) {
  return (
    <Row icon={FILE_ICONS[action]} tone={FILE_TONES[action]}>
      <span className="text-xs">
        <span className="font-mono text-[11px] text-zinc-800 dark:text-zinc-200">{path}</span>{' '}
        <span className="text-zinc-500">({action})</span>
      </span>
    </Row>
  );
}

function InfoRow({ text }: { text: string }) {
  return (
    <Row icon={<Info className="h-3.5 w-3.5" />} tone="text-zinc-400 dark:text-zinc-500">
      <span className="whitespace-pre-wrap break-words text-xs text-zinc-700 dark:text-zinc-300">
        {text}
      </span>
    </Row>
  );
}

function LogRow({ row }: { row: ConsoleLogRow }) {
  switch (row.kind) {
    case 'command':
      return <CommandRow text={row.text} />;
    case 'llm-start':
      return <LlmStartRow model={row.model} />;
    case 'llm-done':
      return <LlmDoneRow seconds={row.seconds} tokens={row.tokens} />;
    case 'llm-retry':
      return <NoticeRow text={row.text} label="Rate limit" />;
    case 'model-switch':
      return <NoticeRow text={row.text} label="Model switch" />;
    case 'error':
      return <ErrorRow text={row.text} />;
    case 'file':
      return <FileRow path={row.path} action={row.action} />;
    default:
      return <InfoRow text={row.text} />;
  }
}

/** One console log line rendered as structured UI (classified on the fly). */
export function ConsoleLogLine({ text }: { text: string }) {
  return <LogRow row={classifyConsoleLog(text)} />;
}
