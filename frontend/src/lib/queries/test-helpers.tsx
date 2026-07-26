/**
 * Shared helpers for the locking tests of lib/queries (and, via the barrel,
 * lib/hooks.ts): a fresh QueryClient per test, a QueryClientProvider wrapper
 * for renderHook, and a fetch mock that records calls and replays queued
 * JSON responses.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import * as React from 'react';
import { vi } from 'vitest';

export type FetchCall = { url: string; method: string; body?: unknown };

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function queryClientWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

export function renderHookWithClient<TResult, TProps>(
  hook: (props: TProps) => TResult,
  queryClient: QueryClient,
  initialProps?: TProps,
) {
  return renderHook(hook, { wrapper: queryClientWrapper(queryClient), initialProps });
}

/** Installs a fetch mock; each queued response is consumed in call order. */
export function mockFetchSequence(...responses: { status?: number; json?: unknown }[]): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = queue.shift() ?? { status: 200, json: {} };
      const status = next.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(next.json ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { calls };
}

/** Last mutation registered in the cache — for asserting options.meta. */
export function lastMutationMeta(queryClient: QueryClient): Record<string, unknown> | undefined {
  const mutations = queryClient.getMutationCache().getAll();
  return mutations.at(-1)?.options.meta as Record<string, unknown> | undefined;
}

/** Query keys currently in the cache (asserts the keys a hook registered). */
export function cachedQueryKeys(queryClient: QueryClient): readonly (readonly unknown[])[] {
  return queryClient.getQueryCache().getAll().map((query) => query.queryKey);
}

/** Registered options of one cached query (refetchInterval, staleTime, …). */
export function cachedQueryOptions(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): { refetchInterval?: unknown; staleTime?: unknown; retry?: unknown } {
  const query = queryClient.getQueryCache().find({ queryKey });
  return query?.options as { refetchInterval?: unknown; staleTime?: unknown; retry?: unknown };
}
