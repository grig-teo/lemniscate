import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { LoginPage } from '@/pages/LoginPage';
import { ShellPage } from '@/pages/ShellPage';

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <ShellPage />,
    },
    {
      path: '/login',
      element: <LoginPage />,
    },
  ],
  // Matches the Vite `base` so the SPA works when served under a subpath.
  { basename: import.meta.env.BASE_URL },
);

export function App() {
  return <RouterProvider router={router} />;
}
