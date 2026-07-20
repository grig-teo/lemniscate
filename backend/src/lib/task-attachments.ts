import { z } from 'zod';
import type { ContentPart, ThinkingLevel } from './llm-client.js';

// Task prompt extras: the per-task thinking-level override and image
// attachments accepted by POST /api/tasks and consumed by the agent worker.

export const TASK_THINKING_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export const taskThinkingLevelSchema = z.enum(TASK_THINKING_LEVELS);

// A 2 MB image is ~2.8 MB of base64; cap the whole data URL at 3 MB of chars.
export const MAX_IMAGE_DATA_URL_CHARS = 3_000_000;
export const MAX_TASK_IMAGES = 3;
export const MAX_IMAGE_NAME_CHARS = 200;

// png/jpeg/webp/gif only, base64-encoded, non-empty payload.
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

export function parseImageDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1] as string, data: match[2] as string };
}

export const imagePayloadSchema = z.object({
  name: z.string().min(1).max(MAX_IMAGE_NAME_CHARS),
  dataUrl: z
    .string()
    .startsWith('data:image/')
    .max(MAX_IMAGE_DATA_URL_CHARS)
    .refine((value) => parseImageDataUrl(value) !== null, 'invalid image data URL'),
});
export type TaskImage = z.infer<typeof imagePayloadSchema>;

export const taskImagesSchema = z.array(imagePayloadSchema).max(MAX_TASK_IMAGES);

// Lenient read side for the worker: the stored Json is trusted but still
// validated; anything malformed degrades to no attachments.
export function parseTaskAttachments(raw: unknown): TaskImage[] {
  const parsed = taskImagesSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// Task.thinkingLevel is stored as plain TEXT (null = use the LLM config's
// level); anything unexpected degrades to no override.
export function parseTaskThinkingLevel(raw: unknown): ThinkingLevel | undefined {
  const parsed = taskThinkingLevelSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function imageContentPart(image: TaskImage): ContentPart {
  return { type: 'image_url', image_url: { url: image.dataUrl } };
}
