import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link, useBeforeUnload } from 'react-router-dom';
import { useTopic, useWritableParents, useCreateTopic, useUpdateTopic } from '../../hooks/useTopics';
import { useAuth } from '../../hooks/useAuth';
import MarkdownEditor from '../../components/admin/MarkdownEditor';
import { VisibilityPicker, VisibilityBadge } from '../../components/admin/VisibilityPicker';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';
import { btn } from '../../components/ui/Modal';
import { slugify, isValidSlug, RESERVED_ROOT_SLUGS } from '../../utils/slug';
import { flattenTree, subtreeIds } from '../../utils/tree';
import { deriveExcerpt } from '../../utils/markdown';

const EMPTY = { title: '', slug: '', content: '', excerpt: '', visibility: 'private', parent_id: '' };

export function Editor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { profile, isAdmin, canWrite } = useAuth();

  const { data: existing, isLoading, error: loadError } = useTopic(isNew ? null : id);
  const { tree, flat } = useWritableParents(profile?.id);
  const create = useCreateTopic();
  const update = useUpdateTopic();

  const [form, setForm] = useState(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    if (isNew) {
      setForm({ ...EMPTY, parent_id: searchParams.get('parent') ?? '' });
      setSlugTouched(false);
      setDirty(false);
    } else if (existing) {
      setForm({
        title: existing.title ?? '',
        slug: existing.slug ?? '',
        content: existing.content ?? '',
        excerpt: existing.excerpt ?? '',
        visibility: existing.visibility ?? 'private',
        parent_id: existing.parent_id ?? '',
      });
      setSlugTouched(true);   // an existing slug is deliberate; never auto-rewrite a live URL
      setDirty(false);
    }
  }, [isNew, existing, searchParams]);

  const set = useCallback((patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setSaveError(null);
  }, []);

  useBeforeUnload(useCallback((e) => { if (dirty) e.preventDefault(); }, [dirty]));

  /**
   * Am I editing someone else's shared page?
   *
   * This is the whole reason the form has two shapes. On a page marked
   * "anyone can edit", a guest may change the words and nothing else —
   * the database refuses a request that would also rename it, move it,
   * change who can see it, or transfer ownership. Rendering those
   * controls anyway would be offering something that cannot work.
   */
  const isGuest = !isNew && existing && !isAdmin && existing.owner_id !== profile?.id;

  const effectiveSlug = slugTouched ? form.slug : slugify(form.title);

  const parentOptions = useMemo(() => {
    const forbidden = isNew
      ? new Set()
      : subtreeIds(flattenTree(tree).find((n) => n.id === id) ?? { id, children: [] });
    return flattenTree(tree)
      .filter((n) => !forbidden.has(n.id))
      .map((n) => ({
        id: n.id,
        label: `${'— '.repeat(Math.max(0, n.depth - 1))}${n.title}`,
        path: n.path,
        shared: n.owner_id !== profile?.id,
      }));
  }, [tree, id, isNew, profile?.id]);

  const parentPath = flat.find((t) => t.id === form.parent_id)?.path;
  const previewUrl = `/${parentPath ? `${parentPath}/` : ''}${effectiveSlug || '…'}`;

  // A parent that is effectively private makes this page private too,
  // whatever is chosen here.
  const parentRow = flat.find((t) => t.id === form.parent_id);
  const inheritedPrivate =
    Boolean(parentRow && parentRow.effective_visibility === 'private' && form.visibility !== 'private');

  const validation = useMemo(() => {
    const problems = [];
    if (!form.title.trim()) problems.push('A title is required.');
    if (effectiveSlug && !isValidSlug(effectiveSlug)) {
      problems.push('The address must be lowercase letters, numbers and single hyphens.');
    }
    if (!form.parent_id && RESERVED_ROOT_SLUGS.has(effectiveSlug)) {
      problems.push(`“${effectiveSlug}” is reserved at the top level. Choose another, or pick a section.`);
    }
    if (form.excerpt.length > 320) problems.push('The summary must be 320 characters or fewer.');
    return problems;
  }, [form, effectiveSlug]);

  const save = useCallback(async () => {
    if (validation.length) return;
    setSaveError(null);

    // A guest sends only the three fields they are allowed to change.
    // Echoing back an unchanged slug or visibility would still pass the
    // database guard, but sending them at all implies a right that is
    // not there.
    const payload = isGuest
      ? { title: form.title.trim(), content: form.content, excerpt: form.excerpt.trim() || null }
      : {
          title: form.title.trim(),
          slug: effectiveSlug || null,
          content: form.content,
          excerpt: form.excerpt.trim() || null,
          visibility: form.visibility,
          parent_id: form.parent_id || null,
        };

    try {
      if (isNew) {
        const row = await create.mutateAsync(payload);
        setDirty(false);
        navigate(`/dashboard/pages/${row.id}`, { replace: true });
      } else {
        await update.mutateAsync({ id, asCollaborator: isGuest, ...payload });
        setDirty(false);
        setSavedAt(new Date());
      }
    } catch (err) {
      setSaveError(err);
    }
  }, [validation, form, effectiveSlug, isNew, isGuest, create, update, id, navigate]);

  if (!isNew && isLoading) {
    return (
      <div className="flex items-center gap-2 py-20 text-sm text-zinc-500">
        <Spinner className="h-5 w-5" /> Loading…
      </div>
    );
  }
  if (loadError) return <ErrorState error={loadError} />;

  const saving = create.isPending || update.isPending;
  const effective = existing?.effective_visibility ?? form.visibility;

  return (
    <div>
      {/* ---------------- header ---------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300">
            ← All pages
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {isNew ? 'New page' : form.title || 'Untitled'}
          </h1>

          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
            <code className="font-mono text-xs text-zinc-400">{previewUrl}</code>
            <VisibilityBadge
              value={effective}
              inherited={!isNew && existing && existing.effective_visibility !== existing.visibility}
            />
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-500">Unsaved changes</span>}
            {!dirty && savedAt && (
              <span className="text-xs text-zinc-400">Saved {savedAt.toLocaleTimeString()}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isNew && existing?.effective_visibility !== 'private' && (
            <a href={`/${existing?.path}`} target="_blank" rel="noreferrer" className={btn.ghost}>
              View ↗
            </a>
          )}
          <button
            type="button"
            className={btn.primary}
            disabled={saving || validation.length > 0 || !canWrite || (!dirty && !isNew)}
            onClick={save}
          >
            {saving && <Spinner className="mr-2 inline h-4 w-4 text-white" />}
            {isNew ? 'Create page' : 'Save'}
          </button>
        </div>
      </div>

      {isGuest && (
        <div className="mb-5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900
                        dark:border-sky-800/60 dark:bg-sky-500/10 dark:text-sky-200">
          <strong>This is a shared page owned by someone else.</strong> You can change the title, the text and
          the summary. Renaming it, moving it, changing who can see it and deleting it stay with its owner.
        </div>
      )}

      {!canWrite && (
        <div className="mb-5">
          <ErrorState compact kind="forbidden" title="Your account is suspended"
                      message="You can read everything as before, but changes cannot be saved until an administrator reactivates the account." />
        </div>
      )}

      {saveError && <div className="mb-4"><ErrorState compact error={saveError} /></div>}
      {validation.length > 0 && dirty && (
        <div className="mb-4">
          <ErrorState compact kind="validation" title="Fix these before saving"
                      message={validation.join(' ')} />
        </div>
      )}

      {/* ---------------- metadata ---------------- */}
      <div className="mb-5 grid gap-5 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="title" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Title
            </label>
            <input
              id="title"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Rate Limiter"
              className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm
                         focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>

          {!isGuest && (
            <>
              <div>
                <div className="flex items-baseline justify-between">
                  <label htmlFor="slug" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Address
                  </label>
                  {slugTouched && isNew && (
                    <button type="button" onClick={() => { setSlugTouched(false); set({ slug: '' }); }}
                            className="text-xs text-brand-600 hover:underline dark:text-brand-400">
                      Reset to title
                    </button>
                  )}
                </div>
                <input
                  id="slug"
                  value={effectiveSlug}
                  onChange={(e) => { setSlugTouched(true); set({ slug: slugify(e.target.value) }); }}
                  placeholder="rate-limiter"
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm
                             focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800"
                />
                <p className="mt-1.5 text-xs text-zinc-400">
                  {isNew
                    ? 'Taken from the title; edit to override. Duplicates are numbered automatically.'
                    : 'Changing this changes the page address. The old one keeps working — it redirects here.'}
                </p>
              </div>

              <div>
                <label htmlFor="parent" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Section
                </label>
                <select
                  id="parent"
                  value={form.parent_id}
                  onChange={(e) => set({ parent_id: e.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm
                             focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <option value="">— Top level —</option>
                  {parentOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}{o.shared ? '  (shared)' : ''}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-zinc-400">
                  Only sections you own or that are open to everyone are listed.
                </p>
              </div>
            </>
          )}
        </div>

        {!isGuest && (
          <div className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
            <VisibilityPicker
              value={form.visibility}
              onChange={(visibility) => set({ visibility })}
              inheritedPrivate={inheritedPrivate}
            />
          </div>
        )}

        <div className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <div className="flex items-baseline justify-between">
            <label htmlFor="excerpt" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Summary
            </label>
            <button type="button" onClick={() => set({ excerpt: deriveExcerpt(form.content) })}
                    className="text-xs text-brand-600 hover:underline dark:text-brand-400">
              Generate from content
            </button>
          </div>
          <textarea
            id="excerpt"
            rows={2}
            maxLength={320}
            value={form.excerpt}
            onChange={(e) => set({ excerpt: e.target.value })}
            placeholder="One or two sentences. Used as the page description and in search results."
            className="mt-1.5 w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm
                       focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800"
          />
          <p className="mt-1 text-right text-xs text-zinc-400">{form.excerpt.length}/320</p>
        </div>
      </div>

      <MarkdownEditor value={form.content} onChange={(content) => set({ content })} onSave={save} />

      {!isNew && existing && (
        <p className="mt-4 text-xs text-zinc-400">
          Created {new Date(existing.created_at).toLocaleString()} · Last updated{' '}
          {new Date(existing.updated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default Editor;
