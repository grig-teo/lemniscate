import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { BrandMark } from '@/components/BrandMark';
import { ThemeToggle } from '@/components/ThemeToggle';
import { buttonVariants } from '@/components/ui/button';
import { useHasActiveProcesses } from '@/lib/queries/tasks';
import { useMe } from '@/lib/hooks';

function AuthAction() {
  const me = useMe();
  if (me.isPending) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />;
  }
  if (me.data) {
    return (
      <Link to="/dashboard" className={buttonVariants({ size: 'sm' })}>
        Dashboard
      </Link>
    );
  }
  return (
    <Link to="/login" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      Log in
    </Link>
  );
}

/** Landing top bar: logo + name, session-aware auth action and theme toggle. */
export function LandingHeader() {
  const animate = useHasActiveProcesses();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <BrandMark animate={animate} />
      <div className="flex items-center gap-2">
        <AuthAction />
        <ThemeToggle />
      </div>
    </header>
  );
}
