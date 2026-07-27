import { config } from '../config.js';

// Email transport for notification delivery, plus the failure type shared
// with the webhook transport. Extracted from notification-delivery.ts.

// Failure carrying the HTTP status (if any) for the audit row.
export class DeliveryError extends Error {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function sendEmail(target: string, payload: Record<string, unknown>): Promise<void> {
  if (!config.SMTP_HOST) {
    throw new DeliveryError('SMTP not configured (set SMTP_HOST/SMTP_FROM to enable email)');
  }
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  const lines = [String(payload.body ?? '')];
  if (payload.prUrl) lines.push('', String(payload.prUrl));
  await transport.sendMail({
    from: config.SMTP_FROM,
    to: target,
    subject: String(payload.title ?? 'Lemniscate notification'),
    text: lines.join('\n'),
  });
}
