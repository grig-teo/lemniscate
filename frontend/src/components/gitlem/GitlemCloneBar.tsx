import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Read-only clone URL with a copy-to-clipboard button. Gitlem clones
 * authenticate over HTTP Basic with the account's emailed PAT.
 */
export function GitlemCloneBar({ cloneUrl }: { cloneUrl: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (non-secure context); the input is selectable
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input value={cloneUrl} readOnly className="font-mono text-xs" aria-label="Clone URL" />
      <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
