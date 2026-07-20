import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { LoginPage } from '@/pages/LoginPage';
import { ShellPage } from '@/pages/ShellPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <ShellPage />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
