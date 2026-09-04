import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import * as topics from '../services/topics';
import * as admin from '../services/admin';
import { buildTree } from '../utils/tree';

/**
 * React Query wrappers.
 *
 * The caching policy here IS the performance strategy (§14). There is no
 * Redis and no CDN cache of API responses; there is a correctly
 * configured client cache, which for a documentation site does the same
 * job for free:
 *
 *   navTree  — one request for the entire site's structure, then 5
 *              minutes of staleTime. Navigating between pages re-reads it
 *              from memory, so the sidebar never refetches.
 *   page     — cached per path. The browser Back button and any repeat
 *              visit within the session are instant and cost 0 requests.
 *
 * Net effect: a cold visit is 2 requests (tree + page); every subsequent
 * page view in that session is 1.
 */

export const queryKeys = {
  navTree: ['nav-tree'],
  page: (path) => ['page', path],
  redirect: (path) => ['redirect', path],
  search: (q) => ['search', q],
  myTopics: (uid) => ['my-topics', uid],
  allTopics: ['all-topics'],
  users: ['admin-users'],
  topic: (id) => ['topic', id],
  descendants: (id) => ['descendants', id],
};

const FIVE_MINUTES = 5 * 60 * 1000;

export function useNavTree() {
  const query = useQuery({
    queryKey: queryKeys.navTree,
    queryFn: topics.getNavigationTree,
    staleTime: FIVE_MINUTES,
    gcTime: 30 * 60 * 1000,
  });
  // Assemble the tree once per fetch rather than on every render.
  const tree = query.data ? buildTree(query.data) : [];
  return { ...query, tree, flat: query.data ?? [] };
}

export function usePage(path) {
  return useQuery({
    queryKey: queryKeys.page(path),
    queryFn: () => topics.getTopicByPath(path),
    enabled: Boolean(path),
    staleTime: FIVE_MINUTES,
    retry: (count, error) => error?.kind === 'network' && count < 2,
  });
}

/** Only runs when a page lookup came back empty — the 404 fallback. */
export function useRedirect(path, enabled) {
  return useQuery({
    queryKey: queryKeys.redirect(path),
    queryFn: () => topics.resolveRedirect(path),
    enabled: Boolean(path) && enabled,
    staleTime: FIVE_MINUTES,
    retry: false,
  });
}

export function useSearch(query) {
  return useQuery({
    queryKey: queryKeys.search(query),
    queryFn: () => topics.searchTopics(query),
    enabled: (query || '').trim().length >= 2,
    placeholderData: keepPreviousData, // no flicker between keystrokes
    staleTime: 60 * 1000,
  });
}

/* ---------------- authoring ---------------- */

/**
 * The pages this member owns.
 *
 * Note that this returns a FOREST, not one tree: a member's pages are
 * scattered through the site, so their dashboard is the set of pages
 * they own, re-rooted. buildTree promotes any page whose parent is not
 * in the set to a top-level entry, which is exactly the behaviour needed
 * here — a page you own inside someone else's shared folder still
 * appears, rather than vanishing because its parent is missing.
 */
export function useMyTopics(userId) {
  const query = useQuery({
    queryKey: queryKeys.myTopics(userId),
    queryFn: () => topics.getMyTopics(userId),
    enabled: Boolean(userId),
    staleTime: 30 * 1000,
  });
  const tree = query.data ? buildTree(query.data) : [];
  return { ...query, tree, flat: query.data ?? [] };
}

/**
 * Sections this member may create a page inside: their own, plus
 * anything marked "anyone can edit".
 *
 * Mirrors can_edit() in SQL. Not a security check — the INSERT policy
 * answers the same question server-side — it is what stops the parent
 * dropdown from listing sections the save would then bounce.
 */
export function useWritableParents(userId) {
  const query = useQuery({
    queryKey: ['writable-parents', userId],
    queryFn: () => topics.getWritableParents(userId),
    enabled: Boolean(userId),
    staleTime: 30 * 1000,
  });
  return { ...query, tree: query.data ? buildTree(query.data) : [], flat: query.data ?? [] };
}

/** Every page in the system. Returns only what RLS allows — admins see all. */
export function useAllTopics(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.allTopics,
    queryFn: topics.getAllTopics,
    enabled,
    staleTime: 30 * 1000,
  });
  const tree = query.data ? buildTree(query.data) : [];
  return { ...query, tree, flat: query.data ?? [] };
}

export function useTopic(id) {
  return useQuery({
    queryKey: queryKeys.topic(id),
    queryFn: () => topics.getTopicById(id),
    enabled: Boolean(id),
  });
}

export function useDescendantCount(id, enabled) {
  return useQuery({
    queryKey: queryKeys.descendants(id),
    queryFn: () => topics.descendantCount(id),
    enabled: Boolean(id) && enabled,
    staleTime: 0,
  });
}

/**
 * Any write invalidates BOTH trees and every cached page.
 *
 * Blunt on purpose: a rename or a move rewrites the `path` of an
 * arbitrary number of pages, so there is no reliable way to know which
 * cache entries are now wrong. Writes happen a few times an hour, at
 * which point re-fetching one small tree is cheaper than reasoning about
 * partial invalidation — and far cheaper than serving a stale URL.
 */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['my-topics'] });
    qc.invalidateQueries({ queryKey: ['writable-parents'] });
    qc.invalidateQueries({ queryKey: queryKeys.allTopics });
    qc.invalidateQueries({ queryKey: queryKeys.navTree });
    qc.invalidateQueries({ queryKey: ['page'] });
    qc.invalidateQueries({ queryKey: ['redirect'] });
  };
}

export function useCreateTopic() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: topics.createTopic, onSuccess: invalidate });
}

export function useUpdateTopic() {
  const qc = useQueryClient();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, asCollaborator, ...input }) =>
      topics.updateTopic(id, input, { asCollaborator }),
    onSuccess: (row) => {
      qc.setQueryData(queryKeys.topic(row.id), row);
      invalidate();
    },
  });
}

export function useDeleteTopic() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, cascade }) => topics.deleteTopic(id, cascade),
    onSuccess: invalidate,
  });
}

export function useMoveTopic() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, parentId, position }) => topics.moveTopic(id, parentId, position),
    onSuccess: invalidate,
  });
}

export function useReorderSiblings() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ parentId, orderedIds }) => topics.reorderSiblings(parentId, orderedIds),
    onSuccess: invalidate,
  });
}

/* ---------------- administration ---------------- */

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: admin.listUsers,
    enabled,
    staleTime: 15 * 1000,
  });
}

/**
 * Every account mutation invalidates the user list AND the page trees.
 *
 * The page trees matter because these actions are not confined to the
 * accounts table: deleting a member transfers every page they owned, and
 * suspending one changes who may edit what. A user list that refreshed
 * alone would leave the dashboard showing pages under the wrong owner.
 */
function useInvalidateUsers() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.users });
    qc.invalidateQueries({ queryKey: ['my-topics'] });
    qc.invalidateQueries({ queryKey: queryKeys.allTopics });
  };
}

export function useSetUserRole() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: ({ userId, role }) => admin.setUserRole(userId, role),
    onSuccess: invalidate,
  });
}

export function useSetUserStatus() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: ({ userId, status }) => admin.setUserStatus(userId, status),
    onSuccess: invalidate,
  });
}

export function useDeleteUser() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: ({ userId }) => admin.deleteUser(userId),
    onSuccess: invalidate,
  });
}
