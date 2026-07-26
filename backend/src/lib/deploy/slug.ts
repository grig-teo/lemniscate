// Slug helpers for service URLs: https://apps.grig-teo.space/<owner>/<name>.
// Pure and unit-tested (tests/deploy-slug.test.ts).

// Lowercase DNS-safe slug: [a-z0-9-], dashes collapsed, trimmed. Anything
// else becomes a dash. Returns '' when nothing usable remains.
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

// Public path of a service, e.g. '/grig-teo/my-app'. Both segments are
// slugified; the owner comes from the git connection username.
export function servicePath(ownerUsername: string, serviceName: string): string {
  const owner = slugify(ownerUsername);
  const name = slugify(serviceName);
  if (!owner || !name) throw new Error('service path needs a non-empty owner and name');
  return `/${owner}/${name}`;
}
