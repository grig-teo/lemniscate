import { describe, expect, it, vi } from 'vitest';
import { DeviceHub, type DeviceSocket } from '../src/lib/device-hub.js';

// Unit tests for the in-memory device hub: presence tracking and command
// push over registered sockets, using fake sockets (no real WebSocket).

function fakeSocket(): DeviceSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), close: vi.fn() };
}

describe('DeviceHub', () => {
  it('reports offline before register and online after', () => {
    const hub = new DeviceHub();
    expect(hub.isOnline('dev-1')).toBe(false);
    hub.register('dev-1', fakeSocket());
    expect(hub.isOnline('dev-1')).toBe(true);
  });

  it('goes offline once the last socket unregisters', () => {
    const hub = new DeviceHub();
    const first = fakeSocket();
    const second = fakeSocket();
    hub.register('dev-1', first);
    hub.register('dev-1', second);
    hub.unregister('dev-1', first);
    expect(hub.isOnline('dev-1')).toBe(true);
    hub.unregister('dev-1', second);
    expect(hub.isOnline('dev-1')).toBe(false);
  });

  it('unregister is a no-op for unknown devices and sockets', () => {
    const hub = new DeviceHub();
    expect(() => hub.unregister('nope', fakeSocket())).not.toThrow();
    expect(hub.isOnline('nope')).toBe(false);
  });

  it('sendCommand returns false and sends nothing when offline', () => {
    const hub = new DeviceHub();
    expect(hub.sendCommand('dev-1', { id: 'cmd-1' })).toBe(false);
  });

  it('sendCommand pushes JSON to every socket of the device', () => {
    const hub = new DeviceHub();
    const first = fakeSocket();
    const second = fakeSocket();
    hub.register('dev-1', first);
    hub.register('dev-1', second);
    const message = { id: 'cmd-1', type: 'run_web', payload: { port: 3000 } };
    expect(hub.sendCommand('dev-1', message)).toBe(true);
    expect(first.send).toHaveBeenCalledWith(JSON.stringify(message));
    expect(second.send).toHaveBeenCalledWith(JSON.stringify(message));
  });

  it('does not leak commands to other devices', () => {
    const hub = new DeviceHub();
    const other = fakeSocket();
    hub.register('dev-2', other);
    hub.sendCommand('dev-1', { id: 'cmd-1' });
    expect(other.send).not.toHaveBeenCalled();
  });

  it('close closes every socket of the device and drops it', () => {
    const hub = new DeviceHub();
    const socket = fakeSocket();
    hub.register('dev-1', socket);
    hub.close('dev-1');
    expect(socket.close).toHaveBeenCalledOnce();
    expect(hub.isOnline('dev-1')).toBe(false);
  });
});
