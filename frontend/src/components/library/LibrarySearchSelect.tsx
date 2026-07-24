import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

import { canNextPage, canPrevPage, pageCount, type LibraryItem, type LibraryPage } from '@/lib/library';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Search-activated, paginated library picker used by the create-repository
 * dialog (skills, AGENTS.md templates, MCP servers). The dropdown renders
 * only while the search field is non-empty; each page shows 5 items with
 * name + short description.
 */

export interface LibrarySearchSelectProps {
  label: string;
  placeholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  page: number;
  onPageChange: (page: number) => void;
  result: LibraryPage | undefined;
  isLoading: boolean;
  isSelected: (item: LibraryItem) => boolean;
  onToggle: (item: LibraryItem) => void;
  /** Rendered instead of "Nothing matches." — e.g. an inline create form. */
  emptyContent?: ReactNode;
}

function ResultRow({
  item,
  selected,
  onToggle,
}: {
  item: LibraryItem;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onToggle}
      className={`flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent ${
        selected ? 'bg-accent/60' : ''
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
      </span>
      {selected && <span className="shrink-0 text-xs font-medium text-primary">✓</span>}
    </button>
  );
}

function Pager({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const pages = pageCount(total, pageSize);
  return (
    <div className="flex items-center justify-between border-t px-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={!canPrevPage(page)}
        onClick={() => onPageChange(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Button>
      <span className="text-xs text-muted-foreground">
        {page} / {pages} · {total}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={!canNextPage(page, total, pageSize)}
        onClick={() => onPageChange(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

export function LibrarySearchSelect(props: LibrarySearchSelectProps) {
  const active = props.search.trim().length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={props.search}
          onChange={(event) => {
            props.onSearchChange(event.target.value);
            props.onPageChange(1);
          }}
          placeholder={props.placeholder}
          aria-label={props.label}
          className="h-9 pl-8"
        />
      </div>
      {active && (
        <div className="rounded-md border" role="listbox" aria-label={`${props.label} results`}>
          <div className="flex max-h-44 min-w-0 flex-col overflow-y-auto p-1">
            {props.isLoading && (
              <p className="px-2 py-3 text-sm text-muted-foreground">Searching…</p>
            )}
            {!props.isLoading && (props.result?.items.length ?? 0) === 0 && (
              props.emptyContent ?? (
                <p className="px-2 py-3 text-sm text-muted-foreground">Nothing matches.</p>
              )
            )}
            {props.result?.items.map((item) => (
              <ResultRow
                key={item.id}
                item={item}
                selected={props.isSelected(item)}
                onToggle={() => props.onToggle(item)}
              />
            ))}
          </div>
          {props.result && props.result.total > 0 && (
            <Pager
              page={props.page}
              total={props.result.total}
              pageSize={props.result.pageSize}
              onPageChange={props.onPageChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
