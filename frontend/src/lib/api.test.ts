import { describe, expect, it } from 'vitest';

import { ApiError, describeApiError } from './api';

describe('describeApiError', () => {
  it('returns the plain message when there are no issues', () => {
    expect(describeApiError(new ApiError(400, 'Invalid request body'))).toBe('Invalid request body');
  });

  it('appends zod issue paths and messages', () => {
    const error = new ApiError(400, 'Invalid request body', {
      error: 'Invalid request body',
      issues: [
        { path: ['temperature'], message: 'Expected number, received string', code: 'invalid_type' },
        { path: ['customHeaders'], message: 'Required', code: 'invalid_type' },
      ],
    });
    expect(describeApiError(error)).toBe(
      'Invalid request body — temperature: Expected number, received string; customHeaders: Required',
    );
  });

  it('caps the summary at three issues', () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({ path: [`f${i}`], message: 'bad' }));
    const text = describeApiError(new ApiError(400, 'Invalid request body', { issues }));
    expect(text).toBe('Invalid request body — f0: bad; f1: bad; f2: bad');
  });

  it('passes through non-ApiError errors unchanged', () => {
    expect(describeApiError(new Error('boom'))).toBe('boom');
  });
});
