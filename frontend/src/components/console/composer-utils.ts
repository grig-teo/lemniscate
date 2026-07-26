/**
 * Non-rendering TaskComposer helpers: the auto-resize textarea hook, image
 * file reading, and the Cmd/Ctrl+Enter submit shortcut. Extracted from
 * TaskComposer.tsx (AGENTS.md section 2) — rendering lives in
 * TaskComposerFields.tsx / TaskComposerControls.tsx, form state in
 * useTaskComposer.ts.
 */
import * as React from 'react';

import type { TaskImage } from '@/lib/api-types';
import {
  clampTextareaHeight,
  isAcceptedImage,
  MAX_IMAGES,
} from '@/lib/prompt-composer';

// Auto-growing textarea bounds: ~3 rows initially, up to ~5 rows, then the
// textarea scrolls internally (overflow-y-auto).
const TEXTAREA_LINE_HEIGHT_PX = 20; // text-sm line-height
const TEXTAREA_VERTICAL_PADDING_PX = 16; // py-2, top + bottom
export const TEXTAREA_MIN_ROWS = 3;
const TEXTAREA_MAX_ROWS = 5;
const TEXTAREA_MIN_HEIGHT =
  TEXTAREA_MIN_ROWS * TEXTAREA_LINE_HEIGHT_PX + TEXTAREA_VERTICAL_PADDING_PX;

/** Grows the textarea with its content, clamped to the min/max row bounds. */
export function useAutoResizeTextarea(value: string, maxRows = TEXTAREA_MAX_ROWS) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const maxHeight = maxRows * TEXTAREA_LINE_HEIGHT_PX + TEXTAREA_VERTICAL_PADDING_PX;
    el.style.height = 'auto';
    el.style.height = `${clampTextareaHeight(el.scrollHeight, TEXTAREA_MIN_HEIGHT, maxHeight)}px`;
  }, [value, maxRows]);
  return ref;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Read accepted image files as data URLs and append them, capped at MAX_IMAGES. */
export function appendImageFiles(
  files: FileList | null,
  setImages: React.Dispatch<React.SetStateAction<TaskImage[]>>,
) {
  if (!files) return;
  const accepted = Array.from(files).filter(isAcceptedImage);
  for (const file of accepted) {
    void readFileAsDataUrl(file).then((dataUrl) => {
      setImages((prev) =>
        prev.length >= MAX_IMAGES ? prev : [...prev, { name: file.name, dataUrl }],
      );
    });
  }
}

/** Cmd/Ctrl+Enter submits the composer from inside the textarea. */
export function submitOnCmdEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void,
) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submit();
  }
}
