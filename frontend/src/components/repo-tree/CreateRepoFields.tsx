/**
 * Presentational pieces of the create-repository dialog (extracted from
 * CreateRepoDialog.tsx per AGENTS.md section 2): the connection picker, the
 * private/README switch rows, and the post-success warnings panel.
 */
import type { Connection } from '@/lib/hooks';
import type { CreateRepoInitialized } from '@/lib/create-repo';
import { providerLabel } from '@/lib/providers';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export function ConnectionSelect({
  connections,
  value,
  onChange,
}: {
  connections: Connection[];
  value: string;
  onChange: (connectionId: string) => void;
}) {
  return (
    <FormField label="Connection">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Connection">
          <SelectValue placeholder="Pick a connection" />
        </SelectTrigger>
        <SelectContent>
          {connections.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {providerLabel(connection.provider)} @{connection.username}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** Post-success panel: the repo was created but initialization reported warnings. */
export function InitializedWarnings({
  initialized,
  onDone,
}: {
  initialized: CreateRepoInitialized;
  onDone: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm">Repository created, with initialization warnings:</p>
      <ul className="list-disc rounded-md border border-amber-500/40 bg-amber-500/10 p-3 pl-7 text-sm">
        {initialized.warnings.map((warning) => (
          <li key={warning} className="break-words">
            {warning}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      {label}
    </label>
  );
}
