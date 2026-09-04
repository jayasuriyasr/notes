import { useState, useEffect } from 'react';
import { Modal, btn } from '../ui/Modal';
import { useDescendantCount } from '../../hooks/useTopics';
import { ErrorState } from '../ui/ErrorState';
import { Spinner } from '../ui/Spinner';

/**
 * Deletion, with the blast radius stated before the button is armed (§13).
 *
 * Two layers stop an accidental subtree wipe:
 *   - The FK on topics.parent_id is NO ACTION, so a plain delete of a page
 *     that has children fails in the database. Nothing is lost even if
 *     this dialog were bypassed entirely.
 *   - Here, deleting a page with descendants requires typing its title.
 *     Confirmation friction should scale with consequences: a leaf page
 *     is one click, a nine-page section is not.
 */
export function DeleteDialog({ open, node, onClose, onConfirm, isPending, error }) {
  const { data: descendants = 0, isLoading } = useDescendantCount(node?.id, open);
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => setConfirmText(''), [node?.id, open]);

  if (!node) return null;

  const hasChildren = descendants > 0;
  const armed = !hasChildren || confirmText.trim() === node.title;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Delete “${node.title}”`}
      footer={
        <>
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btn.danger}
            disabled={!armed || isPending || isLoading}
            onClick={() => onConfirm(node.id, hasChildren)}
          >
            {isPending && <Spinner className="mr-2 inline h-4 w-4 text-white" />}
            {hasChildren ? `Delete all ${descendants + 1} pages` : 'Delete page'}
          </button>
        </>
      }
    >
      {error && <div className="mb-4"><ErrorState compact error={error} /></div>}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner className="h-4 w-4" /> Checking what is beneath this page…
        </div>
      ) : hasChildren ? (
        <>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
            <p className="font-medium">
              This will permanently delete {descendants + 1} pages.
            </p>
            <p className="mt-1 opacity-90">
              “{node.title}” and every page nested beneath it, including their Markdown content. This cannot
              be undone.
            </p>
          </div>

          <label htmlFor="confirm-title" className="mt-4 block text-sm text-zinc-600 dark:text-zinc-400">
            Type <span className="font-semibold text-zinc-900 dark:text-zinc-100">{node.title}</span> to confirm
          </label>
          <input
            id="confirm-title"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />

          <p className="mt-3 text-xs text-zinc-500">
            Considering unpublishing instead? An unpublished page disappears from the public site but keeps
            its content and its URL.
          </p>
        </>
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Permanently delete “{node.title}”? It has no sub-pages. This cannot be undone.
        </p>
      )}
    </Modal>
  );
}

export default DeleteDialog;
