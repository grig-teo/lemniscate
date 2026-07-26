import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '@/App';
import { Toasts } from '@/components/Toasts';
import { reportMutationError } from '@/lib/mutation-error-toast';
import { ThemeProvider } from '@/lib/theme';
import '@/index.css';

const queryClient = new QueryClient({
  // Global fallback: every failed mutation surfaces a toast with the
  // human-readable error, unless the mutation opted out via
  // `meta: SUPPRESS_ERROR_TOAST_META` (it renders its own error inline).
  mutationCache: new MutationCache({ onError: reportMutationError }),
  defaultOptions: {
    queries: {
      // Session/API data is small and changes via user action; avoid
      // refetch storms while still staying reasonably fresh.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
        <Toasts />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
