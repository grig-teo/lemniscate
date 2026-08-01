import * as React from 'react';
import { Settings } from 'lucide-react';
import { FormattedMessage } from 'react-intl';

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
import { OPEN_SETTINGS_EVENT, type SettingsTab } from '@/lib/error-codes';

import { AgentSection } from '@/components/settings/AgentSection';
import { ConnectionsSection } from '@/components/settings/ConnectionsSection';
import { EventTriggersSection } from '@/components/settings/EventTriggersSection';
import { LanguageSelect } from '@/components/settings/LanguageSelect';
import { LlmConfigsSection } from '@/components/settings/LlmConfigsSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { RepoFlagsSection } from '@/components/settings/RepoFlagsSection';
import { UsageSection } from '@/components/settings/UsageSection';
import { VpsTargetsSection } from '@/components/settings/VpsTargetsSection';

/**
 * Settings dialog: LLM configurations, git host connections, and repository
 * automation flags. Opened from the gear button in the top nav.
 */
export function SettingsDialog() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<SettingsTab>('llm');

  // Allows external components (e.g. ErrorBanner) to open the dialog at a
  // specific tab via openSettingsTab().
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: SettingsTab }>).detail;
      if (detail?.tab) setTab(detail.tab);
      setOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings">
          <Settings className="h-5 w-5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>
              <FormattedMessage id="settings.title" defaultMessage="Settings" />
            </DialogTitle>
            <div className="pr-8">
              <LanguageSelect />
            </div>
          </div>
          <DialogDescription>
            <FormattedMessage
              id="settings.description"
              defaultMessage="Manage LLM configurations, git host connections, and repository automation."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b" role="tablist" aria-label="Settings sections">
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>
            <FormattedMessage id="settings.tab.agent" defaultMessage="Agent" />
          </TabButton>
          <TabButton active={tab === 'llm'} onClick={() => setTab('llm')}>
            <FormattedMessage id="settings.tab.llm" defaultMessage="LLM configs" />
          </TabButton>
          <TabButton active={tab === 'git'} onClick={() => setTab('git')}>
            <FormattedMessage id="settings.tab.git" defaultMessage="Git connections" />
          </TabButton>
          <TabButton active={tab === 'repos'} onClick={() => setTab('repos')}>
            <FormattedMessage id="settings.tab.repos" defaultMessage="Repositories" />
          </TabButton>
          <TabButton active={tab === 'notifications'} onClick={() => setTab('notifications')}>
            <FormattedMessage id="settings.tab.notifications" defaultMessage="Notifications" />
          </TabButton>
          <TabButton active={tab === 'usage'} onClick={() => setTab('usage')}>
            <FormattedMessage id="settings.tab.usage" defaultMessage="Usage" />
          </TabButton>
          <TabButton active={tab === 'vps'} onClick={() => setTab('vps')}>
            <FormattedMessage id="settings.tab.vps" defaultMessage="VPS targets" />
          </TabButton>
        </div>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {tab === 'agent' && <AgentSection />}
          {tab === 'llm' && <LlmConfigsSection />}
          {tab === 'git' && <ConnectionsSection />}
          {tab === 'repos' && (
            <>
              <RepoFlagsSection />
              <EventTriggersSection />
            </>
          )}
          {tab === 'notifications' && <NotificationsSection />}
          {tab === 'usage' && <UsageSection />}
          {tab === 'vps' && <VpsTargetsSection />}
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
