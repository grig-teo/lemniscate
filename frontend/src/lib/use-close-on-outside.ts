/**
 * Shared popover/dropdown dismissal: invokes onClose when a mousedown lands
 * outside the referenced container or when Escape is pressed. Attach the ref
 * to the element wrapping BOTH the trigger and the panel (so trigger clicks
 * keep their toggle behavior); listeners are removed on unmount.
 */
import { useEffect, type RefObject } from 'react';

/** Closes on outside mousedown or Escape. */
export function useCloseOnOutside(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, onClose]);
}
