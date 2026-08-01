/** Repository queries and mutations (GET/PATCH /api/repositories…). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Repository } from '@/lib/api-types';
import type { CreateRepoBody, CreateRepoInitialized } from '@/lib/create-repo';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

export function useRepositories() {
  return useQuery({
    queryKey: ['repositories'],
    queryFn: () =>
      api.get<{ repositories: Repository[] }>('/api/repositories').then((res) => res.repositories),
  });
}

/** Polls whether proposal generation is actually in flight for a repository. */
export function useProposalGenerationStatus(repositoryId: string) {
  return useQuery({
    queryKey: ['proposal-generation-status', repositoryId],
    queryFn: () =>
      api
        .get<{ generating: boolean }>(`/api/repositories/${repositoryId}/proposals/status`)
        .then((res) => res.generating),
    refetchInterval: 10_000,
  });
}

interface RepoFlagsPatch {
  autoCreatePr?: boolean;
  autoReviewPr?: boolean;
  autoMergePr?: boolean;
  autoAddressReview?: boolean;
  autoRunProposals?: boolean;
}

interface RepositorySkillsPatch {
  skillSlugs?: string[];
  agentsMdSkillId?: string | null;
}

/**
 * The one optimistic repository PATCH (AGENTS.md section 6): cancel the list
 * query, apply the patch in the cache, roll back on error, invalidate on
 * settled. `suppressErrorToast` is for callers rendering the error inline.
 */
function useOptimisticRepositoryPatch<TPatch extends object>(options?: {
  suppressErrorToast?: boolean;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TPatch }) =>
      api
        .patch<{ repository: Repository }>(`/api/repositories/${id}`, { ...patch } as Record<string, unknown>)
        .then((res) => res.repository),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ['repositories'] });
      const previous = queryClient.getQueryData<Repository[]>(['repositories']);
      queryClient.setQueryData<Repository[]>(['repositories'], (old) =>
        old?.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(['repositories'], context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
    ...(options?.suppressErrorToast ? { meta: SUPPRESS_ERROR_TOAST_META } : {}),
  });
}

/** PATCH /api/repositories/:id auto-* flags with an optimistic cache update. */
export function useUpdateRepositoryFlags() {
  return useOptimisticRepositoryPatch<RepoFlagsPatch>();
}

/** Repository-level skill selection, optimistic like the flags hook. */
export function useUpdateRepository() {
  // SkillsDialog renders isError inline.
  return useOptimisticRepositoryPatch<RepositorySkillsPatch>({ suppressErrorToast: true });
}

/** POST /api/repositories/flags — rewrite these flags on ALL repositories. */
export function useUpdateAllRepositoryFlags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      flags: Required<
        Pick<RepoFlagsPatch, 'autoCreatePr' | 'autoReviewPr' | 'autoMergePr' | 'autoAddressReview'>
      > & {
        reviewLlmConfigId?: string | null;
      },
    ) => api.post<{ updated: number }>('/api/repositories/flags', { ...flags }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
    meta: SUPPRESS_ERROR_TOAST_META, // RepoFlagsSection renders isError inline
  });
}

/** POST /api/repositories/:id/proposals — enqueue on-demand proposal generation (202). */
export function useGenerateProposals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/api/repositories/${id}/proposals`),
    onSettled: (_data, _error, id) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', id] });
    },
  });
}

/** DELETE /api/repositories/:id — optimistically removes the repo from the list cache. */
export function useDeleteRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<undefined>(`/api/repositories/${id}`),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['repositories'] });
      const previous = queryClient.getQueryData<Repository[]>(['repositories']);
      queryClient.setQueryData<Repository[]>(['repositories'], (old) =>
        old?.filter((repo) => repo.id !== id),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(['repositories'], context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });
}

/** 201 response of POST /api/connections/:id/repositories. */
interface CreateRepoResponse {
  repository: Repository;
  sync: unknown;
  initialized: CreateRepoInitialized;
  initTask?: { id: string } | null;
}

/** POST /api/connections/:id/repositories with the body from buildCreateRepoBody. */
export function useCreateRepository(
  onCreated: (initialized: CreateRepoInitialized, initTask: { id: string } | null) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, body }: { connectionId: string; body: CreateRepoBody }) =>
      api.post<CreateRepoResponse>(`/api/connections/${connectionId}/repositories`, { ...body }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      onCreated(data.initialized, data.initTask ?? null);
    },
    meta: SUPPRESS_ERROR_TOAST_META, // the dialog renders the error inline
  });
}
