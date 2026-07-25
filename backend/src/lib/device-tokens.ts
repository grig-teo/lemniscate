import { createHash, randomBytes, randomInt } from 'node:crypto';

// Device credentials: 6-char pairing codes (typed by the user into the
// agent) and 48-hex device tokens (shown once at claim, stored as sha256).

// No 0/O/1/I — codes are transcribed by hand from screen to device.
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

export function generateDeviceToken(): string {
  return randomBytes(24).toString('hex');
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
