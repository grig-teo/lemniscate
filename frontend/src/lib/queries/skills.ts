/** Skill-library queries and mutations (GET/PUT /api/skills…). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { api } from '@/lib/api';
import type { Skill, SkillCategory, SkillDetail } from '@/lib/api-types';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

const SKILLS_SEARCH_DEBOUNCE_MS = 250;

/** Debounced skills list; the backend matches search over name, description, and content. */
export function useSkills(search: string, category?: string | null) {
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SKILLS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  return useQuery({
    queryKey: ['skills', debouncedSearch, category ?? null],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (category) params.set('category', category);
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return api.get<{ skills: Skill[] }>(`/api/skills${suffix}`).then((res) => res.skills);
    },
  });
}

export function useSkillCategories() {
  return useQuery({
    queryKey: ['skill-categories'],
    queryFn: () =>
      api
        .get<{ categories: SkillCategory[] }>('/api/skills/categories')
        .then((res) => res.categories),
  });
}

/** GET /api/skills/:slug — full row incl. content; disabled until a slug is set. */
export function useSkill(slug: string | null) {
  return useQuery({
    queryKey: ['skill', slug],
    queryFn: () => api.get<SkillDetail>(`/api/skills/${slug}`),
    enabled: slug !== null,
  });
}

/** PUT /api/skills/:slug — edit own library entry (content and/or name/description). */
export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: { content?: string; name?: string; description?: string } }) =>
      api.put<{ skill: SkillDetail }>(`/api/skills/${slug}`, patch).then((res) => res.skill),
    onSuccess: (_skill, { slug }) => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['skill', slug] });
    },
    meta: SUPPRESS_ERROR_TOAST_META, // SkillPreviewDialog renders isError inline
  });
}
