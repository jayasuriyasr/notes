import { useState, useMemo } from 'react';
import { Modal, btn } from '../ui/Modal';
import { flattenTree, subtreeIds } from '../../utils/tree';
import { ErrorState } from '../ui/ErrorState';
import { Spinner } from '../ui/Spinner';

/**
 * Re-parent a topic.
 *
 * The topic's own subtree is disabled in the list. The database rejects a
 * cycle regardless (topics_before_write raises 23514), but a greyed-out
 * option explains the rule before the click rather than after it.
 */
export function MoveDialog({ open, node, tree, onClose, onConfirm, isPending, error }) {
  const [parentId, setParentId] = useState(node?.parent_id ?? '');

  const options = useMemo(() => {
    if (!node) return [];
    const forbidden = subtreeIds(node);
    return flattenTree(tree).map((n) => ({
      id: n.id,
      label: `${'  '.repeat(n.depth - 1)}${n.title}`,
      path: n.path,
      disabled: forbidden.has(n.id),
    }));
  }, [node, tree]);

  if (!node) return null;

  const target = options.find((o) => o.id === parentId);
  const newPath = parentId ? `${target?.path}/${node.slug}` : node.slug;
  const descendants = node.children?.length ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move “${node.title}”`}
      footer={
        <>
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btn.primary}
            disabled={isPending || parentId === (node.parent_id ?? '')}
            onClick={() => onConfirm(node.id, parentId || null)}
          >
            {isPending && <Spinner className="mr-2 inline h-4 w-4 text-white" />}
            Move page
          </button>
        </>
      }
    >
      {error && <div className="mb-4"><ErrorState compact error={error} /></div>}

      <label htmlFor="move-parent" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        New parent
      </label>
      <select
        id="move-parent"
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
        className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
      >
        <option value="">— Top level —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={o.disabled}>
            {o.label}{o.disabled ? '  (cannot move into itself)' : ''}
          </option>
        ))}
      </select>

      <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
        <p className="text-zinc-500">The URL will change to</p>
        <code className="mt-1 block break-all font-mono text-brand-600 dark:text-brand-400">/{newPath}</code>
      </div>

      <p className="mt-4 text-sm text-zinc-500">
        {descendants > 0 && (
          <>
            All {descendants} page{descendants === 1 ? '' : 's'} beneath this one move with it, and their
            URLs update automatically.{' '}
          </>
        )}
        The old address keeps working — every changed URL is recorded as a redirect, so existing links and
        search results are not broken.
      </p>
    </Modal>
  );
}

export default MoveDialog;
