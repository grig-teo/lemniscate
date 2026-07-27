import { describe, expect, it } from 'vitest';

import { FOLLOW_BOTTOM_THRESHOLD_PX, isNearBottom } from '@/lib/use-follow-latest';

function metrics(scrollTop: number) {
  return { scrollHeight: 1000, clientHeight: 200, scrollTop };
}

describe('isNearBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isNearBottom(metrics(800))).toBe(true);
  });

  it('is true within the follow threshold', () => {
    expect(isNearBottom(metrics(800 - FOLLOW_BOTTOM_THRESHOLD_PX))).toBe(true);
  });

  it('is false beyond the follow threshold', () => {
    expect(isNearBottom(metrics(800 - FOLLOW_BOTTOM_THRESHOLD_PX - 1))).toBe(false);
  });

  it('is false when scrolled to the top', () => {
    expect(isNearBottom(metrics(0))).toBe(false);
  });

  it('is true when the content fits without scrolling', () => {
    expect(isNearBottom({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 })).toBe(true);
  });
});
