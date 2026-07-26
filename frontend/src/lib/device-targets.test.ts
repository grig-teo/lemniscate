import { describe, expect, it } from 'vitest';

import {
  androidTargetOptions,
  dockerHint,
  iosTargetOptions,
} from '@/lib/devices';

describe('androidTargetOptions', () => {
  it('returns an empty list without an environment or android devices', () => {
    expect(androidTargetOptions(undefined)).toEqual([]);
    expect(androidTargetOptions(null)).toEqual([]);
    expect(androidTargetOptions({})).toEqual([]);
  });

  it('maps serials, models and transports', () => {
    expect(
      androidTargetOptions({
        androidDevices: [
          { serial: 'abc123', model: 'Pixel 8', transport: 'usb' },
          { serial: '10.0.0.2:5555', transport: 'wifi' },
        ],
      }),
    ).toEqual([
      { value: 'abc123', label: 'Pixel 8', transport: 'usb' },
      { value: '10.0.0.2:5555', label: '10.0.0.2:5555', transport: 'wifi' },
    ]);
  });

  it('falls back to the serial when the model is missing', () => {
    expect(androidTargetOptions({ androidDevices: [{ serial: 'emulator-5554', transport: 'usb' }] })).toEqual([
      { value: 'emulator-5554', label: 'emulator-5554', transport: 'usb' },
    ]);
  });
});

describe('iosTargetOptions', () => {
  it('returns an empty list without an environment', () => {
    expect(iosTargetOptions(undefined)).toEqual([]);
    expect(iosTargetOptions(null)).toEqual([]);
    expect(iosTargetOptions({})).toEqual([]);
  });

  it('lists physical devices first, disabled when unavailable', () => {
    expect(
      iosTargetOptions({
        iosDevices: [
          { name: 'Grig iPhone', udid: '00008110-001', available: true },
          { name: 'Old iPad', udid: '00008110-002', available: false },
        ],
        simulators: [{ name: 'iPhone 16', udid: 'SIM-1', runtime: 'iOS 18.4' }],
      }),
    ).toEqual([
      { value: '00008110-001', label: 'Grig iPhone', disabled: false },
      { value: '00008110-002', label: 'Old iPad', disabled: true },
      { value: 'SIM-1', label: 'iPhone 16 · iOS 18.4', disabled: false },
    ]);
  });

  it('labels simulators without a runtime by name only', () => {
    expect(iosTargetOptions({ simulators: [{ name: 'iPhone 16', udid: 'SIM-1' }] })).toEqual([
      { value: 'SIM-1', label: 'iPhone 16', disabled: false },
    ]);
  });

  it('skips simulators without a udid', () => {
    expect(
      iosTargetOptions({
        simulators: [
          { name: 'iPhone 15' },
          { name: 'iPhone 16', udid: 'SIM-1' },
        ],
      }),
    ).toEqual([{ value: 'SIM-1', label: 'iPhone 16', disabled: false }]);
  });
});

describe('dockerHint', () => {
  it('reports docker as available only when explicitly true', () => {
    expect(dockerHint({ dockerAvailable: true })).toEqual({ text: 'Docker available', warn: false });
  });

  it('warns when docker is missing or was never reported', () => {
    const expected = { text: 'Docker not reported on this device', warn: true };
    expect(dockerHint({ dockerAvailable: false })).toEqual(expected);
    expect(dockerHint({})).toEqual(expected);
    expect(dockerHint(undefined)).toEqual(expected);
    expect(dockerHint(null)).toEqual(expected);
  });
});
