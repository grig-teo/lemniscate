import * as React from 'react';
import { Plus, Rocket } from 'lucide-react';

import { useServices } from '@/lib/hooks';
import { serviceStatusColor } from '@/lib/services';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import { CreateServiceDialog } from '@/components/services/CreateServiceDialog';
import { SectionHeader } from '@/components/sidebar/SectionHeader';

/**
 * Left-nav Services block: one row per deployed service (status dot + name +
 * repo), pinned between the repo list and the device bar. A row opens the
 * ServiceDetail pane; + opens the create dialog. Clicking the "Services"
 * header hides/shows the rows (state owned by RepoTree, persisted).
 */
export function ServicesSection({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const servicesQuery = useServices();
  const { selectedServiceId, selectService } = useWorkspaceSelection();
  const [createOpen, setCreateOpen] = React.useState(false);
  const services = servicesQuery.data ?? [];

  const createButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      aria-label="Create service"
      onClick={() => setCreateOpen(true)}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <div className="border-t">
      <SectionHeader
        label="Services"
        collapsed={collapsed}
        onToggle={onToggle}
        action={createButton}
      />
      {!collapsed && (
        <div className="max-h-36 overflow-y-auto pb-1">
          {services.length === 0 && !servicesQuery.isLoading && (
            <p className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground/70">
              <Rocket className="h-3.5 w-3.5" aria-hidden />
              No services yet — deploy a repo here.
            </p>
          )}
          {services.map((svc) => (
            <button
              key={svc.id}
              type="button"
              onClick={() => selectService(svc.id === selectedServiceId ? null : svc.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                svc.id === selectedServiceId ? 'bg-accent' : ''
              }`}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: serviceStatusColor(svc.status) }}
                aria-label={svc.status}
              />
              <span className="truncate font-medium">{svc.name}</span>
              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                {svc.repository.fullName}
              </span>
            </button>
          ))}
        </div>
      )}
      <CreateServiceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
