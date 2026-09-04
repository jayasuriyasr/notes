import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useUsers, useSetUserRole, useSetUserStatus, useDeleteUser } from '../../hooks/useTopics';
import { Modal, btn } from '../../components/ui/Modal';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';

/**
 * ============================================================
 *  PEOPLE — administrator account management
 * ============================================================
 * Three actions, in ascending order of consequence:
 *
 *   Role       promote to administrator, or demote back to member
 *   Status     suspend (reversible) or reactivate
 *   Delete     remove the account; its pages TRANSFER to you
 *
 * Suspension is presented before deletion on purpose. It solves the same
 * problem — "this person must stop changing things" — without destroying
 * an account, and it can be undone in one click. Deletion is for people
 * who are actually gone.
 *
 * Every guard shown here is also enforced in the database, which is what
 * makes them real. `disabled` on a button is a courtesy; assert_admin_target()
 * is the rule.
 */
export function People() {
  const { profile } = useAuth();
  const { data: users = [], isLoading, error, refetch } = useUsers();

  const setRole = useSetUserRole();
  const setStatus = useSetUserStatus();
  const deleteUser = useDeleteUser();

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  const activeAdmins = users.filter((u) => u.role === 'admin' && u.status === 'active').length;

  const run = async (id, fn) => {
    setActionError(null);
    setNotice(null);
    setBusyId(id);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    setActionError(null);
    try {
      const result = await deleteUser.mutateAsync({ userId: deleteTarget.id });
      setNotice(
        `Removed @${result.username}. ${result.pages_transferred} page` +
          `${result.pages_transferred === 1 ? '' : 's'} transferred to you.`,
      );
      setDeleteTarget(null);
    } catch (err) {
      setActionError(err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Spinner className="h-5 w-5" /> Loading people…
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">People</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {users.length} account{users.length === 1 ? '' : 's'} · {activeAdmins} administrator
          {activeAdmins === 1 ? '' : 's'} ·{' '}
          {users.filter((u) => u.status === 'suspended').length} suspended
        </p>
      </div>

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800
                        dark:border-emerald-800/60 dark:bg-emerald-500/10 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {actionError && (
        <div className="mb-4"><ErrorState compact error={actionError} /></div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">Accounts on this site</caption>
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
              <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Person</th>
              <th scope="col" className="px-2 py-2.5 font-medium">Role</th>
              <th scope="col" className="px-2 py-2.5 font-medium">Pages</th>
              <th scope="col" className="hidden px-2 py-2.5 font-medium md:table-cell">Joined</th>
              <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === profile?.id;
              const isLastAdmin = u.role === 'admin' && activeAdmins <= 1;
              const locked = isSelf || isLastAdmin;
              const busy = busyId === u.id;

              return (
                <tr key={u.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="py-3 pl-4 pr-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-100 text-xs
                                       font-semibold uppercase text-zinc-500 dark:bg-zinc-800">
                        {(u.display_name || u.username).slice(0, 2)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                          {u.display_name || u.username}
                          {isSelf && <span className="ml-1.5 text-xs font-normal text-zinc-400">(you)</span>}
                        </p>
                        <p className="truncate text-xs text-zinc-500">@{u.username} · {u.email}</p>
                      </div>
                    </div>
                  </td>

                  <td className="px-2 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={u.role === 'admin' ? 'brand' : 'zinc'}>
                        {u.role === 'admin' ? 'Administrator' : 'Member'}
                      </Pill>
                      {u.status === 'suspended' && <Pill tone="amber">Suspended</Pill>}
                    </div>
                  </td>

                  <td className="px-2 py-3 text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium tabular-nums">{u.page_count}</span>
                    <span className="text-xs text-zinc-400"> ({u.public_page_count} shared)</span>
                  </td>

                  <td className="hidden px-2 py-3 text-xs text-zinc-400 md:table-cell">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>

                  <td className="py-3 pl-2 pr-4">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {busy && <Spinner className="h-4 w-4" />}

                      <Action
                        disabled={locked || busy}
                        title={
                          isSelf ? 'You cannot change your own role'
                          : isLastAdmin ? 'This is the last active administrator'
                          : undefined
                        }
                        onClick={() =>
                          run(u.id, () =>
                            setRole.mutateAsync({
                              userId: u.id,
                              role: u.role === 'admin' ? 'member' : 'admin',
                            }))
                        }
                      >
                        {u.role === 'admin' ? 'Demote' : 'Make admin'}
                      </Action>

                      <Action
                        disabled={(u.status === 'active' && locked) || busy}
                        title={
                          u.status === 'active' && isSelf ? 'You cannot suspend yourself'
                          : u.status === 'active' && isLastAdmin ? 'This is the last active administrator'
                          : undefined
                        }
                        onClick={() =>
                          run(u.id, () =>
                            setStatus.mutateAsync({
                              userId: u.id,
                              status: u.status === 'active' ? 'suspended' : 'active',
                            }))
                        }
                      >
                        {u.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </Action>

                      <Action
                        danger
                        disabled={locked || busy}
                        title={
                          isSelf ? 'You cannot delete your own account'
                          : isLastAdmin ? 'This is the last active administrator'
                          : undefined
                        }
                        onClick={() => { setActionError(null); setDeleteTarget(u); }}
                      >
                        Delete
                      </Action>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-2xl text-xs text-zinc-500">
        Suspending is reversible and keeps everything: the account and all of its pages stay exactly as they
        are, but the person can no longer create or change anything. Prefer it to deletion unless someone has
        genuinely left.
      </p>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => { setDeleteTarget(null); setActionError(null); }}
        title={deleteTarget ? `Delete @${deleteTarget.username}` : ''}
        footer={
          <>
            <button type="button" className={btn.ghost}
                    onClick={() => { setDeleteTarget(null); setActionError(null); }}>
              Cancel
            </button>
            <button type="button" className={btn.danger} disabled={deleteUser.isPending}
                    onClick={confirmDelete}>
              {deleteUser.isPending && <Spinner className="mr-2 inline h-4 w-4 text-white" />}
              Delete account
            </button>
          </>
        }
      >
        {actionError && <div className="mb-4"><ErrorState compact error={actionError} /></div>}

        {deleteTarget && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Permanently delete the account for{' '}
              <strong className="text-zinc-900 dark:text-zinc-100">{deleteTarget.email}</strong>. They will
              not be able to sign in again.
            </p>

            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-800/50">
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                Their {deleteTarget.page_count} page{deleteTarget.page_count === 1 ? '' : 's'} will transfer
                to you.
              </p>
              <p className="mt-1 text-zinc-500">
                Pages are kept rather than deleted — removing a person should not remove documentation other
                people are reading. You can delete any of them afterwards from “All pages”.
              </p>
            </div>

            <p className="mt-4 text-xs text-zinc-500">
              Only leaving? <strong>Suspend</strong> instead — it stops all their edits and can be undone.
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}

function Pill({ tone, children }) {
  const tones = {
    brand: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Action({ danger, children, ...props }) {
  return (
    <button
      type="button"
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}

export default People;
