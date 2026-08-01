import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Sidebar hover-reveal: the element stays invisible (and unclickable) until
 * its `group` row is hovered (or it receives keyboard focus). Used for row
 * action buttons and auxiliary labels in the left pane so rows stay clean
 * until the cursor is over them.
 */
export const hoverReveal =
  'invisible opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 focus-visible:visible focus-visible:opacity-100';
