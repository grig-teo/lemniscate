import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';

const SWITCH_CLASS =
  'h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3';

/** Small labeled switch used for automation flags in settings forms. */
export function FlagSwitch({
  label,
  ariaLabel,
  checked,
  disabled,
  disabledTitle,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-1.5 text-[11px] text-muted-foreground',
        disabled && 'opacity-50',
      )}
      title={disabled ? disabledTitle : undefined}
    >
      <Switch
        className={SWITCH_CLASS}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={ariaLabel}
      />
      {label}
    </label>
  );
}
