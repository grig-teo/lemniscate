import { GitBranch } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Branch switcher for the gitlem repo detail. Switching the branch re-fetches
 * the README and CI runs for that branch (the parent owns the active branch).
 */
export function GitlemBranchBar({
  branches,
  defaultBranch,
  active,
  onChange,
}: {
  branches: string[];
  defaultBranch: string;
  active: string;
  onChange: (branch: string) => void;
  repoName: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select value={active} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-48" aria-label="Branch">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {branches.map((b) => (
            <SelectItem key={b} value={b}>
              {b}
              {b === defaultBranch ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
