import { MutationCache, QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import { reportMutationError } from '@/lib/mutation-error-toast';
import { clearToasts, pushToast, snapshotToasts } from '@/lib/toasts';
import { Toasts } from '@/components/Toasts';

afterEach(() => clearToasts());

function clientWithGlobalHandler() {
  return new QueryClient({
    mutationCache: new MutationCache({ onError: reportMutationError }),
  });
}

async function runFailingMutation(
  client: QueryClient,
  error: Error,
  options: { meta?: Record<string, unknown> } = {},
) {
  const mutation = client.getMutationCache().build(client, {
    mutationFn: () => Promise.reject(error),
    ...(options.meta ? { meta: options.meta } : {}),
  });
  await mutation.execute(undefined).catch(() => undefined);
}

describe('reportMutationError (global MutationCache onError)', () => {
  it('pushes a toast with the ApiError message when a mutation fails', async () => {
    const client = clientWithGlobalHandler();
    await runFailingMutation(client, new ApiError(401, 'Session expired'));
    expect(snapshotToasts().map((t) => t.message)).toEqual(['Session expired']);
  });

  it('includes zod issue details via describeApiError', async () => {
    const client = clientWithGlobalHandler();
    await runFailingMutation(
      client,
      new ApiError(400, 'Validation failed', {
        issues: [{ path: ['name'], message: 'Required' }],
      }),
    );
    expect(snapshotToasts().map((t) => t.message)).toEqual(['Validation failed — name: Required']);
  });

  it('falls back to the plain Error message for non-ApiError failures', async () => {
    const client = clientWithGlobalHandler();
    await runFailingMutation(client, new Error('network down'));
    expect(snapshotToasts().map((t) => t.message)).toEqual(['network down']);
  });

  it('stays silent for mutations that surface their own error inline (meta.suppressErrorToast)', async () => {
    const client = clientWithGlobalHandler();
    await runFailingMutation(client, new ApiError(500, 'Server error'), {
      meta: { suppressErrorToast: true },
    });
    expect(snapshotToasts()).toEqual([]);
  });
});

describe('<Toasts>', () => {
  it('renders every queued toast message with an alert role', () => {
    clearToasts();
    pushToast('Sync failed: token expired');
    const html = renderToStaticMarkup(<Toasts />);
    expect(html).toContain('Sync failed: token expired');
    expect(html).toContain('role="alert"');
  });

  it('renders nothing when there are no toasts', () => {
    clearToasts();
    expect(renderToStaticMarkup(<Toasts />)).toBe('');
  });
});
