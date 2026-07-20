import { Infinity as InfinityIcon, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ThemeToggle } from '@/components/ThemeToggle';
import { buttonVariants } from '@/components/ui/button';
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
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <InfinityIcon className="h-6 w-6 text-foreground" aria-hidden />
        <span className="text-lg font-semibold tracking-tight">Lemniscate</span>
      </div>
      <div className="flex items-center gap-2">
        <AuthAction />
        <ThemeToggle />
      </div>
    </header>
  );
}
