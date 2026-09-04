import { useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Admin tree with inline actions.
 *
 * ORDERING: up/down buttons rather than drag-and-drop. Dragging a nested
 * tree well is genuinely hard — it needs a drag library, pointer and
 * keyboard equivalents, and drop-target logic for "inside vs between".
 * Two buttons are keyboard-accessible, screen-reader friendly and
 * dependency-free, and each click is one reorder_siblings() call that
 * rewrites the sibling list atomically. Drag-and-drop can be layered on
 * later over the same RPC.
 */
function Row({ node, depth, siblings, index, onAction, busyId }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children?.length > 0;
  const isDraft = node.status === 'draft';
  const busy = busyId === node.id;

  return (
    <>
      <tr className="group border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/30">
        <td className="py-2 pl-3 pr-2">
          <div className="flex items-center" style={{ paddingLeft: `${depth * 20}px` }}>
            {hasChildren ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${node.title}`}
                className="mr-1 flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
                     className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}>
                  <path d="M7 4l6 6-6 6V4z" />
                </svg>
              </button>
            ) : (
              <span className="mr-1 w-5" aria-hidden="true" />
            )}

            <Link
              to={`/admin/topics/${node.id}`}
              className="truncate font-medium text-zinc-800 hover:text-brand-600 dark:text-zinc-200 dark:hover:text-brand-400"
            >
              {node.title}
            </Link>

            {isDraft && (
              <span className="ml-2 shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-400">
                Draft
              </span>
            )}
          </div>
        </td>

        <td className="px-2 py-2">
          <code className="truncate font-mono text-xs text-zinc-400">/{node.path}</code>
        </td>

        <td className="hidden px-2 py-2 text-xs text-zinc-400 md:table-cell">
          {new Date(node.updated_at).toLocaleDateString()}
        </td>

        <td className="py-2 pl-2 pr-3">
          <div className="flex items-center justify-end gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <IconBtn label="Move up" disabled={index === 0 || busy}
                     onClick={() => onAction('up', node, siblings, index)}>↑</IconBtn>
            <IconBtn label="Move down" disabled={index === siblings.length - 1 || busy}
                     onClick={() => onAction('down', node, siblings, index)}>↓</IconBtn>
            <IconBtn label={`Add a page inside ${node.title}`}
                     onClick={() => onAction('add-child', node)}>+</IconBtn>
            <IconBtn label={`Move ${node.title} to another parent`}
                     onClick={() => onAction('move', node)}>⇄</IconBtn>
            <IconBtn label={isDraft ? `Publish ${node.title}` : `Unpublish ${node.title}`}
                     disabled={busy} onClick={() => onAction('toggle-publish', node)}>
              {isDraft ? '◯' : '●'}
            </IconBtn>
            <IconBtn label={`Delete ${node.title}`} danger disabled={busy}
                     onClick={() => onAction('delete', node)}>✕</IconBtn>
          </div>
        </td>
      </tr>

      {hasChildren && open &&
        node.children.map((child, i) => (
          <Row key={child.id} node={child} depth={depth + 1} siblings={node.children}
               index={i} onAction={onAction} busyId={busyId} />
        ))}
    </>
  );
}

function IconBtn({ label, children, danger, ...props }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 place-items-center rounded text-sm transition disabled:opacity-25 ${
        danger
          ? 'text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40'
          : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
      }`}
      {...props}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export function TopicTree({ tree, onAction, busyId }) {
  if (!tree.length) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">No topics yet</p>
        <p className="mt-1 text-sm text-zinc-500">Create your first top-level topic to get started.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <table className="w-full min-w-[42rem] text-sm">
        <caption className="sr-only">Documentation topics, hierarchical</caption>
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
            <th scope="col" className="py-2.5 pl-3 pr-2 font-medium">Title</th>
            <th scope="col" className="px-2 py-2.5 font-medium">URL</th>
            <th scope="col" className="hidden px-2 py-2.5 font-medium md:table-cell">Updated</th>
            <th scope="col" className="py-2.5 pl-2 pr-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tree.map((node, i) => (
            <Row key={node.id} node={node} depth={0} siblings={tree} index={i}
                 onAction={onAction} busyId={busyId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TopicTree;
