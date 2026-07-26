import { LemniscateSwarm } from '@/components/LemniscateSwarm';

/** Lowercase brand wordmark shown next to the animated logo. */
export const BRAND_NAME = 'lemniscate';

/**
 * Brand lockup: animated lemniscate mark next to the lowercase wordmark.
 * The mark is boxed at 1em so it always renders at the label's font size.
 */
export function BrandMark() {
  return (
    <span className="flex items-center gap-2 text-lg">
      <LemniscateSwarm className="h-[1em] w-[1em] text-foreground" />
      <span className="font-semibold tracking-tight">{BRAND_NAME}</span>
    </span>
  );
}
