import type { FastifyPluginAsync } from 'fastify';
import { slugify } from '../lib/deploy/slug.js';
import { prisma } from '../lib/prisma.js';

// Public HTML index of one owner's live apps — Traefik rewrites /<owner>/*
// here (replacePath) for paths no service claimed. Public by design: the
// service URLs themselves are publicly reachable. Mounted under /api.
const APPS_INDEX_ROUTE = '/apps-index/:owner';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export const appsIndexRoute: FastifyPluginAsync = async (app) => {
  app.get(APPS_INDEX_ROUTE, async (request, reply) => {
    const { owner } = request.params as { owner: string };
    const services = await prisma.service.findMany({
      where: { deployTarget: 'lemniscate', status: 'online', activeContainer: { not: null } },
      include: { repository: { include: { connection: { select: { username: true } } } } },
    });
    const owned = services.filter(
      (svc) => slugify(svc.repository.connection.username) === owner,
    );
    const items = owned
      .map(
        (svc) =>
          `      <li><a href="/${escapeHtml(owner)}/${escapeHtml(svc.name)}/">${escapeHtml(svc.name)}</a>` +
          `<span class="repo">${escapeHtml(svc.repository.fullName)}</span></li>`,
      )
      .join('\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(owner)} — Lemniscate Apps</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
    h1 { font-size: 1.4rem; }
    ul { list-style: none; padding: 0; }
    li { display: flex; align-items: baseline; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid #e5e7eb; }
    a { color: #0969da; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .repo { color: #6e7781; font-size: .85rem; }
    .empty { color: #6e7781; }
    footer { margin-top: 3rem; color: #6e7781; font-size: .8rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(owner)} — deployed apps</h1>
${items ? `  <ul>\n${items}\n  </ul>` : '  <p class="empty">No apps deployed yet.</p>'}
  <footer>Powered by Lemniscate</footer>
</body>
</html>`;
    return reply.type('text/html').send(html);
  });
};
