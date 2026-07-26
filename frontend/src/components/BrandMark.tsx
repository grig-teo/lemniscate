import { LemniscateSwarm } from '@/components/LemniscateSwarm';

/** Lowercase brand wordmark shown next to the animated logo. */
export const BRAND_NAME = 'lemniscate';

interface BrandMarkProps {
  /**
   * Whether the lemniscate swarm travels. Defaults to true; callers pass false
   * (or the activity flag) so the mark is static when no task is running or in
   * review.
   */
  animate?: boolean;
}

/**
 * Brand lockup: animated lemniscate mark next to the lowercase wordmark.
 * The mark is boxed at 2em (twice the label font size) so it reads large in
 * the top-left of the app; pass `animate` to drive the swarm.
 */
export function BrandMark({ animate = true }: BrandMarkProps) {
  return (
    <span className="flex items-center gap-2 text-lg">
      <LemniscateSwarm className="h-[2em] w-[2em] text-foreground" animate={animate} />
      <span className="font-semibold tracking-tight">{BRAND_NAME}</span>
    </span>
  );
}
