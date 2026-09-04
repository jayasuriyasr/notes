import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link, useBeforeUnload } from 'react-router-dom';
import { useTopic, useAdminTree, useCreateTopic, useUpdateTopic } from '../../hooks/useTopics';
import MarkdownEditor from '../../components/admin/MarkdownEditor';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';
import { btn } from '../../components/ui/Modal';
import { slugify, isValidSlug, RESERVED_ROOT_SLUGS } from '../../utils/slug';
import { flattenTree, subtreeIds } from '../../utils/tree';
import { deriveExcerpt } from '../../utils/markdown';

const EMPTY = { title: '', slug: '', content: '', excerpt: '', status: 'draft', parent_id: '' };

export function AdminEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const { data: existing, isLoading, error: loadError } = useTopic(isNew ? null : id);
  const { tree, flat } = useAdminTree();
  const create = useCreateTopic();
  const update = useUpdateTopic();

  const [form, setForm] = useState(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Seed the form: an existing topic, or a new one under ?parent=...
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
        status: existing.status ?? 'draft',
        parent_id: existing.parent_id ?? '',
      });
      setSlugTouched(true); // an existing slug is deliberate; never auto-rewrite it
      setDirty(false);
    }
  }, [isNew, existing, searchParams]);

  const set = useCallback((patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setSaveError(null);
  }, []);

  // Warn before losing unsaved Markdown to a tab close or reload.
  useBeforeUnload(
    useCallback((e) => { if (dirty) e.preventDefault(); }, [dirty]),
  );

  const effectiveSlug = slugTouched ? form.slug : slugify(form.title);

  const parentOptions = useMemo(() => {
    const forbidden = isNew
      ? new Set()
      : subtreeIds(flattenTree(tree).find((n) => n.id === id) ?? { id, children: [] });
    return flattenTree(tree)
      .filter((n) => !forbidden.has(n.id))
      .map((n) => ({ id: n.id, label: `${'— '.repeat(n.depth - 1)}${n.title}`, path: n.path }));
  }, [tree, id, isNew]);

  const parentPath = flat.find((t) => t.id === form.parent_id)?.path;
  const previewUrl = `/${parentPath ? `${parentPath}/` : ''}${effectiveSlug || '…'}`;

  // Client-side validation. The database enforces all of this too; this
  // exists to fail fast and explain, not to be trusted.
  const validation = useMemo(() => {
    const problems = [];
    if (!form.title.trim()) problems.push('A title is required.');
    if (effectiveSlug && !isValidSlug(effectiveSlug)) {
      problems.push('The slug must be lowercase letters, numbers and single hyphens.');
    }
    if (!form.parent_id && RESERVED_ROOT_SLUGS.has(effectiveSlug)) {
      problems.push(`“${effectiveSlug}” is reserved at the top level. Choose another slug or pick a parent.`);
    }
    if (form.excerpt.length > 320) problems.push('The summary must be 320 characters or fewer.');
    return problems;
  }, [form, effectiveSlug]);

  const save = useCallback(
    async ({ publish } = {}) => {
      if (validation.length) return;
      setSaveError(null);

      const payload = {
        title: form.title.trim(),
        slug: effectiveSlug || null,
        content: form.content,
        excerpt: form.excerpt.trim() || null,
        status: publish === undefined ? form.status : publish ? 'published' : 'draft',
        parent_id: form.parent_id || null,
      };

      try {
        if (isNew) {
          const row = await create.mutateAsync(payload);
          setDirty(false);
          navigate(`/admin/topics/${row.id}`, { replace: true });
        } else {
          await update.mutateAsync({ id, ...payload });
          setForm((f) => ({ ...f, status: payload.status }));
          setDirty(false);
          setSavedAt(new Date());
        }
      } catch (err) {
        setSaveError(err);
      }
    },
    [validation, form, effectiveSlug, isNew, create, update, id, navigate],
  );

  if (!isNew && isLoading) {
    return (
      <div className="flex items-center gap-2 py-20 text-sm text-zinc-500">
        <Spinner className="h-5 w-5" /> Loading…
      </div>
    );
  }
  if (loadError) return <ErrorState error={loadError} />;

  const saving = create.isPending || update.isPending;
  const isPublished = form.status === 'published';

  return (
    <div>
      {/* ---------------- header ---------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300">
            ← All topics
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {isNew ? 'New topic' : form.title || 'Untitled'}
          </h1>

          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
            <code className="font-mono text-xs text-zinc-400">{previewUrl}</code>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isPublished
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-400'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400'
              }`}
            >
              {form.status}
            </span>
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-500">Unsaved changes</span>}
            {!dirty && savedAt && (
              <span className="text-xs text-zinc-400">Saved {savedAt.toLocaleTimeString()}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isNew && isPublished && (
            <a href={`/${existing?.path}`} target="_blank" rel="noreferrer" className={btn.ghost}>
              View ↗
            </a>
          )}
          <button
            type="button"
            className={btn.ghost}
            disabled={saving || validation.length > 0}
            onClick={() => save({ publish: !isPublished })}
          >
            {isPublished ? 'Unpublish' : 'Publish'}
          </button>
          <button
            type="button"
            className={btn.primary}
            disabled={saving || validation.length > 0 || (!dirty && !isNew)}
            onClick={() => save()}
          >
            {saving && <Spinner className="mr-2 inline h-4 w-4 text-white" />}
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && <div className="mb-4"><ErrorState compact error={saveError} /></div>}

      {validation.length > 0 && dirty && (
        <div className="mb-4">
          <ErrorState compact kind="validation" title="Fix these before saving"
                      message={validation.join(' ')} />
        </div>
      )}

      {/* ---------------- metadata ---------------- */}
      <div className="mb-5 grid gap-4 rounded-xl border border-zinc-200 bg-white p-5 md:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-900">
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

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="slug" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Slug
            </label>
            {slugTouched && (
              <button
                type="button"
                onClick={() => { setSlugTouched(false); set({ slug: '' }); }}
                className="text-xs text-brand-600 hover:underline dark:text-brand-400"
              >
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
              ? 'Derived from the title; edit to override. Duplicates are numbered automatically.'
              : 'Changing this changes the page URL. The old address is redirected automatically.'}
          </p>
        </div>

        <div>
          <label htmlFor="parent" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Parent
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
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-zinc-400">
            A page cannot be moved inside itself, so its own subtree is not listed.
          </p>
        </div>

        <div className="md:col-span-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="excerpt" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Summary
            </label>
            <button
              type="button"
              onClick={() => set({ excerpt: deriveExcerpt(form.content) })}
              className="text-xs text-brand-600 hover:underline dark:text-brand-400"
            >
              Generate from content
            </button>
          </div>
          <textarea
            id="excerpt"
            rows={2}
            maxLength={320}
            value={form.excerpt}
            onChange={(e) => set({ excerpt: e.target.value })}
            placeholder="One or two sentences. Used as the meta description and in search results."
            className="mt-1.5 w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm
                       focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800"
          />
          <p className="mt-1 text-right text-xs text-zinc-400">{form.excerpt.length}/320</p>
        </div>
      </div>

      {/* ---------------- markdown ---------------- */}
      <MarkdownEditor value={form.content} onChange={(content) => set({ content })} onSave={save} />

      {!isNew && existing && (
        <p className="mt-4 text-xs text-zinc-400">
          Created {new Date(existing.created_at).toLocaleString()} · Last updated{' '}
          {new Date(existing.updated_at).toLocaleString()}
          {existing.published_at && <> · First published {new Date(existing.published_at).toLocaleString()}</>}
        </p>
      )}
    </div>
  );
}

export default AdminEditor;
