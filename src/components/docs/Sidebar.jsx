import { useState, useEffect, memo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ancestorPaths } from '../../utils/tree';
import { SidebarSkeleton } from '../ui/Spinner';

/**
 * Recursive navigation tree.
 *
 * Sections auto-expand to reveal the current page, and any section the
 * reader opens or closes by hand stays that way for the session. The
 * expansion state is derived from the URL rather than stored per node,
 * so a deep link opens with exactly the right branches showing.
 */
function TreeNode({ node, openSet, toggle, depth }) {
  const hasChildren = node.children?.length > 0;
  const isOpen = openSet.has(node.path);

  return (
    <li>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggle(node.path)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.title}`}
            className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400
                       hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <svg
              viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            >
              <path d="M7 4l6 6-6 6V4z" />
            </svg>
          </button>
        ) : (
          <span className="mr-0.5 w-5 shrink-0" aria-hidden="true" />
        )}

        <NavLink
          to={`/${node.path}`}
          className={({ isActive }) =>
            `flex-1 truncate rounded-md px-2 py-1.5 text-sm transition ${
              isActive
                ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-400'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100'
            }`
          }
          title={node.title}
        >
          {node.title}
        </NavLink>
      </div>

      {hasChildren && isOpen && (
        <ul className="ml-3 border-l border-zinc-200 pl-1 dark:border-zinc-800">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} openSet={openSet} toggle={toggle} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SidebarBase({ tree, isLoading, currentPath }) {
  const location = useLocation();
  const [openSet, setOpenSet] = useState(() => new Set());

  // Reveal the branch containing the current page whenever the URL changes.
  useEffect(() => {
    const active = currentPath ?? location.pathname.replace(/^\//, '');
    if (!active) return;
    setOpenSet((prev) => {
      const next = new Set(prev);
      // The page's own path is included so a section page shows its children.
      for (const p of ancestorPaths(active)) next.add(p);
      return next;
    });
  }, [currentPath, location.pathname]);

  const toggle = (path) =>
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (isLoading) return <SidebarSkeleton />;

  if (!tree?.length) {
    return (
      <p className="px-2 py-4 text-sm text-zinc-500 dark:text-zinc-400">
        No published pages yet.
      </p>
    );
  }

  return (
    <nav aria-label="Documentation">
      <ul className="space-y-0.5">
        {tree.map((node) => (
          <TreeNode key={node.id} node={node} openSet={openSet} toggle={toggle} depth={0} />
        ))}
      </ul>
    </nav>
  );
}

export const Sidebar = memo(SidebarBase);
export default Sidebar;
