import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useAdminTree, useReorderSiblings, useUpdateTopic, useDeleteTopic, useMoveTopic,
} from '../../hooks/useTopics';
import TopicTree from '../../components/admin/TopicTree';
import MoveDialog from '../../components/admin/MoveDialog';
import DeleteDialog from '../../components/admin/DeleteDialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';
import { btn } from '../../components/ui/Modal';

export function AdminTopics() {
  const navigate = useNavigate();
  const { tree, flat, isLoading, error, refetch } = useAdminTree();

  const reorder = useReorderSiblings();
  const update = useUpdateTopic();
  const remove = useDeleteTopic();
  const move = useMoveTopic();

  const [moveTarget, setMoveTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const counts = flat.reduce(
    (acc, t) => ({
      total: acc.total + 1,
      published: acc.published + (t.status === 'published' ? 1 : 0),
    }),
    { total: 0, published: 0 },
  );

  const onAction = useCallback(
    async (action, node, siblings, index) => {
      setActionError(null);
      try {
        switch (action) {
          case 'add-child':
            navigate(`/admin/topics/new?parent=${node.id}`);
            break;

          case 'move':
            setMoveTarget(node);
            break;

          case 'delete':
            setDeleteTarget(node);
            break;

          case 'toggle-publish':
            setBusyId(node.id);
            await update.mutateAsync({
              id: node.id,
              status: node.status === 'published' ? 'draft' : 'published',
            });
            break;

          case 'up':
          case 'down': {
            setBusyId(node.id);
            const next = [...siblings];
            const swapWith = action === 'up' ? index - 1 : index + 1;
            [next[index], next[swapWith]] = [next[swapWith], next[index]];
            await reorder.mutateAsync({
              parentId: node.parent_id,
              orderedIds: next.map((n) => n.id),
            });
            break;
          }
          default:
            break;
        }
      } catch (err) {
        setActionError(err);
      } finally {
        setBusyId(null);
      }
    },
    [navigate, update, reorder],
  );

  const confirmMove = async (id, parentId) => {
    setActionError(null);
    try {
      await move.mutateAsync({ id, parentId });
      setMoveTarget(null);
    } catch (err) {
      setActionError(err);
    }
  };

  const confirmDelete = async (id, cascade) => {
    setActionError(null);
    try {
      await remove.mutateAsync({ id, cascade });
      setDeleteTarget(null);
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Topics</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {counts.total} page{counts.total === 1 ? '' : 's'} · {counts.published} published ·{' '}
            {counts.total - counts.published} draft
          </p>
        </div>

        <Link to="/admin/topics/new" className={btn.primary}>
          + Create topic
        </Link>
      </div>

      {actionError && (
        <div className="mb-4">
          <ErrorState compact error={actionError} onRetry={() => setActionError(null)} />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
          <Spinner className="h-5 w-5" /> Loading topics…
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <TopicTree tree={tree} onAction={onAction} busyId={busyId} />
      )}

      <MoveDialog
        open={Boolean(moveTarget)}
        node={moveTarget}
        tree={tree}
        onClose={() => { setMoveTarget(null); setActionError(null); }}
        onConfirm={confirmMove}
        isPending={move.isPending}
        error={actionError}
      />

      <DeleteDialog
        open={Boolean(deleteTarget)}
        node={deleteTarget}
        onClose={() => { setDeleteTarget(null); setActionError(null); }}
        onConfirm={confirmDelete}
        isPending={remove.isPending}
        error={actionError}
      />
    </div>
  );
}

export default AdminTopics;
