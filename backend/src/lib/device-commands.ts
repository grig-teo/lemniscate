// Pure helpers for the build_android device pipeline: the server enriches
// the stored command payload with gradle/docker defaults and the upload base
// URL at dispatch time, and chains a finished build into an install_apk
// command for the target android device.

export const BUILD_ANDROID_DEFAULTS = {
  gradleTask: 'assembleDebug',
  gradleModule: 'app',
  image: 'mingc/android-build-box:1.29.0',
} as const;

export interface BuildChainTarget {
  installDeviceId: string;
  artifactKey: string;
  appName?: string;
  deviceSerial?: string;
}

/**
 * Payload sent to the builder agent: stored payload over the gradle/docker
 * defaults, with the server's public origin injected (never agent-set — the
 * agent authenticates the upload with its own device token).
 */
export function buildAndroidAgentPayload(
  payload: Record<string, unknown>,
  uploadBaseUrl: string,
): Record<string, unknown> {
  return { ...BUILD_ANDROID_DEFAULTS, ...payload, uploadBaseUrl };
}

/**
 * Chaining decision after a command result: the install target for a
 * successful build_android, or null when nothing should follow.
 */
export function nextCommandAfterBuild(
  command: { type: string; payload: unknown },
  result: unknown,
): BuildChainTarget | null {
  if (command.type !== 'build_android') return null;
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  const data = (result ?? {}) as Record<string, unknown>;
  if (typeof payload.installDeviceId !== 'string' || typeof data.artifactKey !== 'string') {
    return null;
  }
  return {
    installDeviceId: payload.installDeviceId,
    artifactKey: data.artifactKey,
    appName: typeof payload.appName === 'string' ? payload.appName : undefined,
    deviceSerial: typeof payload.deviceSerial === 'string' ? payload.deviceSerial : undefined,
  };
}

/**
 * Shape of the `result` object on a `failed` command_result frame.
 *
 * - `error`: the human-readable failure message.
 * - `log`: the tail of the build/run log (≤ 2KB), for at-a-glance context.
 * - `logArtifactUrl`: backend-relative download path for the FULL log,
 *   present only when the log exceeded the upload threshold and was stored
 *   as a `.log` artifact. Absent when the log was small enough to fit inline,
 *   or when the upload was rejected (quota exhausted) — in both cases the
 *   tail-only `log` is still present.
 */
export interface FailedCommandResult {
  error: string;
  log: string;
  logArtifactUrl?: string;
}
