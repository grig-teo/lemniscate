import { describe, expect, it } from 'vitest';

import { PRIORITY_ORDER, PRIORITY_STYLES } from '@/lib/priority';

describe('PRIORITY_STYLES', () => {
  it('has a style for every priority, highest first', () => {
    expect(PRIORITY_ORDER).toEqual(['critical', 'high', 'medium', 'low']);
    for (const priority of PRIORITY_ORDER) {
      expect(PRIORITY_STYLES[priority]).toBeTruthy();
    }
  });
});
