import type { VpsTarget } from '@/lib/hooks';

/**
 * Deploy-target selector: Lemniscate (platform apps network) vs VPS (user's
 * own server via SSH). When 'vps' is chosen, shows a dropdown of the user's
 * saved VpsTarget profiles. Shared by CreateServiceDialog and ServiceDetail.
 */
export function DeployTargetFields({
  deployTarget,
  vpsTargetId,
  vpsTargets,
  onTargetChange,
  onVpsChange,
}: {
  deployTarget: 'lemniscate' | 'vps';
  vpsTargetId: string;
  vpsTargets: VpsTarget[];
  onTargetChange: (target: 'lemniscate' | 'vps') => void;
  onVpsChange: (id: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-sm">
        Deploy target
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={deployTarget}
          onChange={(event) => onTargetChange(event.target.value as 'lemniscate' | 'vps')}
        >
          <option value="lemniscate">Lemniscate (apps.grig-teo.space)</option>
          <option value="vps">My VPS (SSH)</option>
        </select>
      </label>
      {deployTarget === 'vps' && (
        <>
          <label className="grid gap-1 text-sm">
            VPS target
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={vpsTargetId}
              onChange={(event) => onVpsChange(event.target.value)}
            >
              <option value="" disabled>
                {vpsTargets.length === 0 ? 'No VPS targets — add one in Settings' : 'Select a VPS target…'}
              </option>
              {vpsTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} ({target.username}@{target.host}:{target.port})
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
