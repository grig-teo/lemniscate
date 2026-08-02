/** Gitlem (internal git host) repository queries against /api/gitlem/repos. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useRepositories } from '@/lib/queries/repositories';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

// The gitlem repos grid filters the standard repository list by the gitlem
// connection (gitlem repos sync into GET /api/repositories like any git host).
export function useGitlemRepos() {
  const repos = useRepositories();
  const gitlemRepos = repos.data?.filter((r) => r.connection.provider === 'gitlem') ?? [];
  return { ...repos, data: gitlemRepos };
}

export interface GitlemRepoDetail {
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  cloneUrl: string;
  branches: string[];
  openPrs: number;
}

export interface GitlemPr {
  number: number;
  title: string;
  head: string;
  base: string;
  state: 'open' | 'closed' | 'merged';
}

/** Full PR payload for the standalone PR page (any state, with body). */
export interface GitlemPrDetail extends GitlemPr {
  body: string;
  createdAt: string;
  repo: string;
}

export interface GitlemPrFileChange {
  path: string;
  status: 'added' | 'modified';
  headLines: number;
  baseLines: number;
}

export interface GitlemCiRun {
  id: string;
  branch: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  log: string;
  createdAt: string;
}

/** GET /api/gitlem/repos/:name — repo detail (branches, cloneUrl, openPrs count). */
export function useGitlemRepoDetail(name: string | null) {
  return useQuery({
    queryKey: ['gitlem', 'repo', name],
    enabled: name !== null,
    queryFn: () => api.get<{ repository: GitlemRepoDetail }>(`/api/gitlem/repos/${name}`).then((r) => r.repository),
  });
}

/** GET /api/gitlem/repos/:name/readme/:branch — README content for a branch. */
export function useGitlemReadme(name: string, branch: string) {
  return useQuery({
    queryKey: ['gitlem', 'repo', name, 'readme', branch],
    queryFn: () =>
      api.get<{ branch: string; path: string; content: string }>(`/api/gitlem/repos/${name}/readme/${branch}`),
    // 404 = no README on this branch; treat as empty data, not an error toast.
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** GET /api/gitlem/repos/:name/prs — open pull requests. */
export function useGitlemPrs(name: string | null) {
  return useQuery({
    queryKey: ['gitlem', 'repo', name, 'prs'],
    enabled: name !== null,
    queryFn: () => api.get<{ prs: GitlemPr[] }>(`/api/gitlem/repos/${name}/prs`).then((r) => r.prs),
  });
}

/** GET /api/gitlem/repos/:name/prs/:number — one PR (any state) + changed files. */
export function useGitlemPr(name: string | null, number: number | null) {
  return useQuery({
    queryKey: ['gitlem', 'repo', name, 'prs', number],
    enabled: name !== null && number !== null,
    queryFn: () =>
      api.get<{ pr: GitlemPrDetail; files: GitlemPrFileChange[] }>(
        `/api/gitlem/repos/${name}/prs/${number}`,
      ),
    // 404 = wrong owner or unknown PR; the page renders its own not-found state.
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** GET /api/gitlem/repos/:name/ci-runs — recent CI runs (latest 20). */
export function useGitlemCiRuns(name: string | null) {
  return useQuery({
    queryKey: ['gitlem', 'repo', name, 'ci-runs'],
    enabled: name !== null,
    queryFn: () => api.get<{ runs: GitlemCiRun[] }>(`/api/gitlem/repos/${name}/ci-runs`).then((r) => r.runs),
  });
}

function useInvalidateGitlem(name: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['gitlem', 'repo', name] }),
      queryClient.invalidateQueries({ queryKey: ['gitlem', 'repo', name, 'prs'] }),
      queryClient.invalidateQueries({ queryKey: ['gitlem', 'repo', name, 'ci-runs'] }),
      queryClient.invalidateQueries({ queryKey: ['repositories'] }),
    ]);
}

/** POST /api/gitlem/repos/:name/branches — create a branch from another. */
export function useCreateGitlemBranch(name: string) {
  const invalidate = useInvalidateGitlem(name);
  return useMutation({
    mutationFn: (body: { name: string; from?: string }) =>
      api.post<{ name: string }>(`/api/gitlem/repos/${name}/branches`, body),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** POST /api/gitlem/repos/:name/ci/:branch — trigger a CI run on a branch. */
export function useTriggerGitlemCi(name: string) {
  const invalidate = useInvalidateGitlem(name);
  return useMutation({
    mutationFn: (branch: string) => api.post<{ run: GitlemCiRun }>(`/api/gitlem/repos/${name}/ci/${branch}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
