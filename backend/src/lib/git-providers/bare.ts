import { requestJson } from './http.js';

// Bare-repo detection: a repo is bare when its root has zero entries or
// nothing but docs and git meta files. Shared by every provider — GitHub-
// shaped providers (github/gitverse/gitee) expose the root listing at
// /repos/{fullName}/contents; GitLab uses /projects/{id}/repository/tree
// (see gitlab.ts).

// Root entries that carry no implementation: docs and git meta files only.
const BARE_ROOT_ENTRY =
  /^(readme(\..+)?|license(\..+)?|copying(\..+)?|\.gitignore|\.gitattributes)$/i;

// Pure judge for a root listing: a repo is bare when its root has zero
// entries or nothing but README/LICENSE/COPYING/.gitignore/.gitattributes.
export function isBareRootListing(names: string[]): boolean {
  return names.every((name) => BARE_ROOT_ENTRY.test(name));
}

// Shared root-listing fetch for every provider: entry names (files and
// dirs) of the repository root. Throws ProviderError on API failure.
export async function fetchRootEntryNames(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<string[]> {
  const data = (await requestJson(url, headers, provider)) as Array<{ name?: unknown }>;
  if (!Array.isArray(data)) return [];
  return data.map((entry) => String(entry?.name ?? ''));
}

// Bare-repo probe shared by every provider: fetch the root listing and judge
// the entry names. Any API error (404/403/…) returns false so a failed
// check never breaks repository sync.
export async function rootListingIsBare(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<boolean> {
  try {
    return isBareRootListing(await fetchRootEntryNames(url, headers, provider));
  } catch {
    return false;
  }
}

// Root-listing URL of the GitHub-shaped providers (github/gitverse/gitee).
export function contentsUrl(apiBase: string, repoFullName: string): string {
  return `${apiBase}/repos/${repoFullName}/contents?per_page=100`;
}
