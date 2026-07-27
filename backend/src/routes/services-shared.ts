import { z } from 'zod';
import { decrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

// Shared pieces for the services route modules: param schema, ownership
// lookup, and env-key listing.

export const idParamsSchema = z.object({ id: z.string().min(1) });

// envEnc holds AES-256-GCM JSON; keys are safe to list, values never are.
export function envKeys(envEnc: string): string[] {
  try {
    return Object.keys(JSON.parse(decrypt(envEnc)) as Record<string, string>);
  } catch {
    return [];
  }
}

export async function ownedService(userId: string, id: string) {
  return prisma.service.findFirst({
    where: { id, repository: { connection: { userId } } },
    include: {
      repository: {
        select: {
          id: true,
          fullName: true,
          defaultBranch: true,
          connection: { select: { username: true, provider: true } },
        },
      },
      vpsTarget: { select: { id: true, name: true, host: true, port: true, username: true, authMethod: true, secretEnc: true } },
      deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}
