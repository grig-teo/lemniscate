// In-memory presence/command hub for connected device agents. Maps a device
// id to its live WebSocket(s); the REST routes and the WS gateway share the
// `deviceHub` singleton. Presence is process-local by design (single VPS).

// Minimal socket shape the hub needs — ws's WebSocket satisfies it.
export interface DeviceSocket {
  send(data: string): void;
  close(): void;
}

export class DeviceHub {
  private readonly sockets = new Map<string, Set<DeviceSocket>>();

  register(deviceId: string, socket: DeviceSocket): void {
    const set = this.sockets.get(deviceId) ?? new Set<DeviceSocket>();
    set.add(socket);
    this.sockets.set(deviceId, set);
  }

  unregister(deviceId: string, socket: DeviceSocket): void {
    const set = this.sockets.get(deviceId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return (this.sockets.get(deviceId)?.size ?? 0) > 0;
  }

  /** Pushes the message as JSON to every socket of the device; false when offline. */
  sendCommand(deviceId: string, message: unknown): boolean {
    const set = this.sockets.get(deviceId);
    if (!set || set.size === 0) return false;
    const data = JSON.stringify(message);
    for (const socket of set) socket.send(data);
    return true;
  }

  /** Closes every socket of the device (e.g. when the device is deleted). */
  close(deviceId: string): void {
    const set = this.sockets.get(deviceId);
    if (!set) return;
    for (const socket of set) socket.close();
    this.sockets.delete(deviceId);
  }
}

export const deviceHub = new DeviceHub();
