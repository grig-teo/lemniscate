import type { Prisma } from '@prisma/client';
import { z } from 'zod';

// Zod schemas and platform rules for the devices API (see devices.ts for
// the route registration).

// Gradle module/task names land inside a `sh -c` script on the builder —
// keep them strictly alphanumeric so no shell injection is possible.
const gradleName = z.string().regex(/^[a-zA-Z0-9_-]+$/);

export const claimBodySchema = z.object({
  code: z.string().length(6),
  name: z.string().min(1).max(80),
  platform: z.enum(['android', 'ios', 'desktop', 'web']),
  meta: z.record(z.unknown()).optional(),
});

export const idParamSchema = z.object({ id: z.string().min(1).max(100) });

export const renameBodySchema = z.object({ name: z.string().min(1).max(80) });

const commandBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_web'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      port: z.number().int().min(1).max(65535),
      composePath: z.string().min(1).max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal('install_apk'),
    payload: z.object({
      apkUrl: z.string().url(),
      appName: z.string().min(1).max(120).optional(),
      // Lands in `adb -s <serial>` on the agent — no shell metacharacters.
      deviceSerial: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
    }),
  }),
  // User-facing part of a build request; the server adds gradle/docker
  // defaults and uploadBaseUrl at dispatch (lib/device-dispatch.ts), and the
  // install chaining fields via POST /api/repositories/:id/deploy-android.
  z.object({
    type: z.literal('build_android'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      gradleTask: gradleName.optional(),
      gradleModule: gradleName.optional(),
      image: z.string().min(1).max(200).optional(),
      // Forwarded to the chained install_apk (same `adb -s` constraint).
      deviceSerial: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
    }),
  }),
  // startScript lands inside an `npm run <script>` spawn on the device —
  // keep it strictly alphanumeric (plus npm's : _ - conventions).
  z.object({
    type: z.literal('run_desktop'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      startScript: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9:_-]+$/)
        .optional(),
    }),
  }),
  // scheme/destination are passed to xcodebuild on a macOS agent; both
  // optional — the agent auto-detects when omitted. destination is a UDID
  // (xcodebuild `-destination id=<udid>`), so hex-and-dashes only.
  z.object({
    type: z.literal('run_ios'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      scheme: z.string().min(1).max(200).optional(),
      destination: z.string().min(1).max(200).regex(/^[a-zA-Z0-9-]+$/).optional(),
    }),
  }),
]);

// Optional link back to the task whose result the command runs.
export const createCommandBodySchema = commandBodySchema.and(
  z.object({ taskId: z.string().min(1).max(100).optional() }),
);

// install_apk launches an install intent on Android; on desktop the agent
// only downloads the file. iOS/web devices cannot receive APKs at all.
const INSTALL_APK_PLATFORMS = new Set(['android', 'desktop']);

export function installApkBlock(platform: string): string | null {
  if (INSTALL_APK_PLATFORMS.has(platform)) return null;
  return `install_apk is only available on android and desktop devices (this device is ${platform})`;
}

// run_desktop spawns a GUI app via npm on the machine itself — only
// desktop agents can do that.
export function runDesktopBlock(platform: string): string | null {
  if (platform === 'desktop') return null;
  return `run_desktop is only available on desktop devices (this device is ${platform})`;
}

// tokenHash is never selected — the token is shown once at claim time.
export const deviceSelect = {
  id: true,
  name: true,
  platform: true,
  meta: true,
  lastSeenAt: true,
  createdAt: true,
} satisfies Prisma.DeviceSelect;

// Live environment report from the agent: docker plus the run targets it can
// see (adb devices, iOS devices/simulators, Android emulators). Lists default
// empty so a minimal report still parses; unknown fields are stripped.
const capabilitiesSchema = z.object({
  dockerAvailable: z.boolean().default(false),
  androidDevices: z
    .array(
      z.object({
        serial: z.string().min(1).max(200),
        model: z.string().max(200).optional(),
        transport: z.enum(['usb', 'wifi']),
      }),
    )
    .max(50)
    .default([]),
  iosDevices: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        udid: z.string().min(1).max(200),
        available: z.boolean(),
      }),
    )
    .max(50)
    .default([]),
  simulators: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        runtime: z.string().max(200).optional(),
        state: z.string().max(50).optional(),
      }),
    )
    .max(100)
    .default([]),
  emulators: z.array(z.object({ name: z.string().min(1).max(200) })).max(100).default([]),
});

const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), meta: z.record(z.unknown()).optional() }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('capabilities'), capabilities: capabilitiesSchema }),
  z.object({
    type: z.literal('command_result'),
    id: z.string().min(1).max(100),
    status: z.enum(['running', 'done', 'failed']),
    result: z.unknown().optional(),
  }),
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Parses one raw agent frame; null when not valid JSON or not a known message. */
export function parseAgentMessage(raw: string): AgentMessage | null {
  try {
    const parsed = agentMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
