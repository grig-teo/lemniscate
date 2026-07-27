/**
 * run_ios helpers for the Lemniscate device agent: xcodegen/Xcode project
 * discovery, simctl/devicectl parsing, and xcodebuild invocation.
 * Extracted from lib.js — pure functions plus fs lookups, no other I/O.
 */
import fs from 'node:fs';
import path from 'node:path';

// --- run_ios helpers ------------------------------------------------------------

/**
 * Directory holding an xcodegen project.yml, ios/ first then the repo root;
 * null when the repo has no xcodegen setup.
 */
export function xcodegenDir(projectDir) {
  for (const dir of ['ios', '.']) {
    if (fs.existsSync(path.join(projectDir, dir, 'project.yml'))) {
      return path.join(projectDir, dir);
    }
  }
  return null;
}

/**
 * Locate the Xcode project to build: ios/ first, then the repo root, then any
 * other one-level-deep directory (alphabetical) for monorepo layouts; within a
 * directory a .xcworkspace wins over a .xcodeproj. Returns
 * {flag, path, name} or null.
 */
export function findXcodeProject(projectDir) {
  const others = fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'ios' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const dir of ['ios', '.', ...others]) {
    const abs = path.join(projectDir, dir);
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    const workspace = names.find((name) => name.endsWith('.xcworkspace'));
    if (workspace) {
      return { flag: '-workspace', path: path.join(abs, workspace), name: workspace.replace(/\.xcworkspace$/, '') };
    }
    const project = names.find((name) => name.endsWith('.xcodeproj'));
    if (project) {
      return { flag: '-project', path: path.join(abs, project), name: project.replace(/\.xcodeproj$/, '') };
    }
  }
  return null;
}

/** All UDIDs known to simctl, from `xcrun simctl list devices -j` JSON. */
function simctlUdids(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return Object.values(data.devices ?? {}).flat().map((device) => device.udid).filter(Boolean);
}

/** True when the UDID belongs to a simulator (not a physical device). */
export function isSimulatorUdid(jsonText, udid) {
  return simctlUdids(jsonText).includes(udid);
}

/** First booted simulator UDID from `xcrun simctl list devices -j` JSON. */
export function parseBootedSimulatorUdid(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  for (const devices of Object.values(data.devices ?? {})) {
    for (const device of devices) {
      if (device.state === 'Booted' && device.udid) return device.udid;
    }
  }
  return null;
}

/** First available iPhone simulator ({udid, name}) from simctl list JSON. */
export function parseAvailableIphone(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    if (!runtime.includes('iOS')) continue;
    for (const device of devices) {
      if (device.isAvailable !== false && device.udid && /iPhone/.test(device.name ?? '')) {
        return { udid: device.udid, name: device.name };
      }
    }
  }
  return null;
}

/**
 * First .app under a derived-data Products dir (e.g. Debug-iphonesimulator or
 * Debug-iphoneos), null when the build produced none.
 */
export function findBuiltApp(productsRoot) {
  if (!fs.existsSync(productsRoot)) return null;
  for (const dir of fs.readdirSync(productsRoot).sort()) {
    if (!/-(iphonesimulator|iphoneos)$/.test(dir)) continue;
    const full = path.join(productsRoot, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const app = fs.readdirSync(full).find((name) => name.endsWith('.app'));
    if (app) return path.join(full, app);
  }
  return null;
}

/** xcodebuild invocation for a simulator or device destination build. */
export function xcodebuildArgs({ flag, projectPath, scheme, destination, derivedDataPath }) {
  return [
    flag, projectPath,
    '-scheme', scheme,
    '-destination', destination,
    '-derivedDataPath', derivedDataPath,
    'build',
  ];
}
