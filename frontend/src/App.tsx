import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import { useMe } from '@/lib/hooks';
import { LandingPage } from '@/pages/LandingPage';
import { LoginPage } from '@/pages/LoginPage';
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
  return <RouterProvider router={router} />;
}
