import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import { useFaviconActivity } from '@/lib/favicon-activity';
import { useMe } from '@/lib/hooks';
import { useHasActiveProcesses } from '@/lib/queries/tasks';
import { LandingPage } from '@/pages/LandingPage';
import { LoginPage } from '@/pages/LoginPage';
import { GitlemConnectPage } from '@/pages/GitlemConnectPage';
import { GitlemPrPage } from '@/pages/GitlemPrPage';
import { ShellPage } from '@/pages/ShellPage';

/** Gate for authenticated routes: spinner while the session loads, /login on 401. */
function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <LandingPage />,
    },
    {
      path: '/login',
      element: <LoginPage />,
    },
    {
      path: '/connect/gitlem',
      element: <GitlemConnectPage />,
    },
    {
      // Internal git host PR links (task prUrls) land here.
      path: '/gitlem/repos/:owner/:repo/pulls/:number',
      element: (
        <RequireAuth>
          <GitlemPrPage />
        </RequireAuth>
      ),
    },
    {
      path: '/dashboard',
      element: (
        <RequireAuth>
          <ShellPage />
        </RequireAuth>
      ),
    },
  ],
  // Matches the Vite `base` so the SPA works when served under a subpath.
  { basename: import.meta.env.BASE_URL },
);

export function App() {
  // Animate the browser tab icon while any task is running or in review, so
  // the activity is visible even on backgrounded tabs.
  useFaviconActivity(useHasActiveProcesses());
  return <RouterProvider router={router} />;
}
