import * as React from 'react';
import { Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { ConnectionsSection } from '@/components/settings/ConnectionsSection';
import { LlmConfigsSection } from '@/components/settings/LlmConfigsSection';
import { RepoFlagsSection } from '@/components/settings/RepoFlagsSection';

type SettingsTab = 'llm' | 'git' | 'repos';

/**
 * Settings dialog: LLM configurations, git host connections, and repository
 * automation flags. Opened from the gear button in the top nav.
 */
export function SettingsDialog() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<SettingsTab>('llm');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings">
          <Settings className="h-5 w-5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage LLM configurations, git host connections, and repository automation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b" role="tablist" aria-label="Settings sections">
          <TabButton active={tab === 'llm'} onClick={() => setTab('llm')}>
            LLM configs
          </TabButton>
          <TabButton active={tab === 'git'} onClick={() => setTab('git')}>
            Git connections
          </TabButton>
          <TabButton active={tab === 'repos'} onClick={() => setTab('repos')}>
            Repositories
          </TabButton>
        </div>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {tab === 'llm' && <LlmConfigsSection />}
          {tab === 'git' && <ConnectionsSection />}
          {tab === 'repos' && <RepoFlagsSection />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
        active && 'border-primary text-foreground',
      )}
    >
      {children}
    </button>
  );
}
