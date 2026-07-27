/**
 * Scroll-position-aware auto-follow ("sticky scroll") for streaming log
 * views: the container only pins itself to the bottom on new output while
 * the user is already at (or near) the bottom. Scrolling up disengages
 * follow mode; `jumpToLatest` re-engages it on demand.
 */
import * as React from 'react';

/** Distance from the bottom (px) within which the view still counts as following. */
export const FOLLOW_BOTTOM_THRESHOLD_PX = 40;

/** Upper bound for the smooth jump animation; the jump guard expires after it. */
const SMOOTH_JUMP_TIMEOUT_MS = 800;

interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom(el: ScrollMetrics): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_THRESHOLD_PX;
}

function scrollElementToBottom(el: HTMLElement, behavior: ScrollBehavior) {
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior });
    return;
  }
  el.scrollTop = el.scrollHeight;
}

type FollowingRef = React.MutableRefObject<boolean>;

/** Follow flag: a ref for effect guards plus state to drive the jump button. */
function useFollowing(): {
  followingRef: FollowingRef;
  isFollowingLatest: boolean;
  setFollowing: (value: boolean) => void;
} {
  const followingRef = React.useRef(true);
  const [isFollowingLatest, setIsFollowingLatest] = React.useState(true);
  const setFollowing = (value: boolean) => {
    followingRef.current = value;
    setIsFollowingLatest(value);
  };
  return { followingRef, isFollowingLatest, setFollowing };
}

/** Count entries that arrive while the user is scrolled up reading history. */
function useUnreadCount(
  entryCount: number,
  followingRef: FollowingRef,
  isFollowingLatest: boolean,
): number {
  const prevCountRef = React.useRef(entryCount);
  const [unreadCount, setUnreadCount] = React.useState(0);

  React.useEffect(() => {
    if (isFollowingLatest) setUnreadCount(0);
  }, [isFollowingLatest]);

  React.useEffect(() => {
    const arrived = entryCount - prevCountRef.current;
    prevCountRef.current = entryCount;
    if (followingRef.current || arrived <= 0) return;
    setUnreadCount((count) => count + arrived);
  }, [entryCount, followingRef]);

  return unreadCount;
}

/** Pin to the bottom on new output, but only while following. */
function usePinOnAppend(
  scrollRef: React.RefObject<HTMLDivElement>,
  followingRef: FollowingRef,
  scrollDeps: readonly unknown[],
) {
  React.useEffect(() => {
    const el = scrollRef.current;
    if (followingRef.current && el) scrollElementToBottom(el, 'auto');
  }, scrollDeps);
}

export interface FollowLatestController {
  scrollRef: React.RefObject<HTMLDivElement>;
  isFollowingLatest: boolean;
  unreadCount: number;
  handleScroll: () => void;
  jumpToLatest: () => void;
}

export function useFollowLatest(
  entryCount: number,
  scrollDeps: readonly unknown[],
): FollowLatestController {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const jumpingRef = React.useRef(false);
  const jumpTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { followingRef, isFollowingLatest, setFollowing } = useFollowing();
  const unreadCount = useUnreadCount(entryCount, followingRef, isFollowingLatest);
  usePinOnAppend(scrollRef, followingRef, scrollDeps);

  const finishJump = () => {
    jumpingRef.current = false;
    if (jumpTimeoutRef.current) clearTimeout(jumpTimeoutRef.current);
    jumpTimeoutRef.current = null;
  };

  // Handled synchronously (not rAF-throttled): the evaluation is three
  // property reads, and deferring it lets a concurrent log append re-pin
  // the view before the user's scroll-up is registered.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Ignore intermediate positions emitted during the smooth jump animation.
    if (jumpingRef.current && !isNearBottom(el)) return;
    finishJump();
    setFollowing(isNearBottom(el));
  };

  const jumpToLatest = () => {
    jumpingRef.current = true;
    setFollowing(true);
    jumpTimeoutRef.current = setTimeout(finishJump, SMOOTH_JUMP_TIMEOUT_MS);
    const el = scrollRef.current;
    if (el) scrollElementToBottom(el, 'smooth');
  };

  React.useEffect(
    () => () => {
      if (jumpTimeoutRef.current) clearTimeout(jumpTimeoutRef.current);
    },
    [],
  );

  return { scrollRef, isFollowingLatest, unreadCount, handleScroll, jumpToLatest };
}
