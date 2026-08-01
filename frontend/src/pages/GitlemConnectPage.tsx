import { ArrowLeft, Infinity as InfinityIcon, Loader2 } from 'lucide-react';
import { Navigate, Link, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useGitlemLogin, useGitlemRegister, useGitlemRequestCode, useMe } from '@/lib/hooks';
import { useGitlemConnectForm } from '@/pages/gitlem/use-gitlem-connect-form';

function GitlemConnectCard() {
  const navigate = useNavigate();
  const form = useGitlemConnectForm({
    login: useGitlemLogin(),
    requestCode: useGitlemRequestCode(),
    register: useGitlemRegister(),
    onDone: () => navigate('/dashboard'),
  });

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border bg-card p-8 shadow-sm">
      <div className="flex flex-col items-center gap-2">
        <InfinityIcon className="h-10 w-10 text-foreground" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Connect Gitlem</h1>
        <p className="text-center text-sm text-muted-foreground">
          {form.mode === 'login'
            ? 'Sign in to the internal git host with your email and password.'
            : 'Register: we send a code to your email, then set up your account.'}
        </p>
      </div>

      <form onSubmit={form.submit} className="flex w-full flex-col gap-3">
        {form.fields}
        {form.error && <p className="text-sm text-destructive">{form.error}</p>}
        {form.notice && <p className="text-sm text-muted-foreground">{form.notice}</p>}
        <Button type="submit" disabled={form.submitDisabled}>
          {form.submitLabel}
        </Button>
      </form>

      <button type="button" onClick={form.toggleMode} className="text-xs text-muted-foreground hover:underline">
        {form.mode === 'login' ? 'No account? Register with a code' : 'Already have an account? Sign in'}
      </button>

      <Link to="/login" className="flex items-center gap-1 text-xs text-muted-foreground hover:underline">
        <ArrowLeft className="h-3 w-3" /> Back to login
      </Link>
    </div>
  );
}

/**
 * /connect/gitlem — sign in or register on the internal gitlem git host with
 * email + password (login) or email → code → register. A successful login or
 * registration creates a lemniscate session and redirects to /dashboard.
 * Already-authenticated visitors bounce straight to /dashboard.
 */
export function GitlemConnectPage() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (me.data) return <Navigate to="/dashboard" replace />;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <GitlemConnectCard />
    </div>
  );
}
