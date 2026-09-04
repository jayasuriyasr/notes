import { supabase } from '../lib/supabase';
import { unwrap } from '../lib/errors';

/**
 * ============================================================
 *  ADMINISTRATOR OPERATIONS
 * ============================================================
 * Every function here calls a SECURITY DEFINER database function, and
 * that is the whole point: these operations write columns no policy
 * exposes (`profiles.role`, `profiles.status`) or delete rows from
 * `auth.users`, which an `authenticated` caller cannot touch at all.
 *
 * The authorisation is NOT in this file. Each database function begins
 * with `if not public.is_admin() then raise 42501`, and enforces two
 * further invariants that keep an installation administrable:
 *
 *   - you cannot demote, suspend or delete your own account
 *   - you cannot remove the last active administrator
 *
 * So a member who calls any of these from the browser console gets
 * "Administrator access is required" from PostgreSQL, not from React.
 */

/** Every account, with page counts. Admin-only; raises otherwise. */
export async function listUsers() {
  return unwrap(await supabase.rpc('admin_list_users'));
}

/** Promote to 'admin' or demote to 'member'. */
export async function setUserRole(userId, role) {
  return unwrap(await supabase.rpc('admin_set_role', { p_user_id: userId, p_role: role }));
}

/**
 * Suspend or reactivate.
 *
 * Suspension is the reversible answer and should usually be preferred to
 * deletion: the account and every page it owns survive untouched, but
 * `is_active()` stops returning true, so every write policy declines and
 * the member is reduced to an ordinary reader.
 */
export async function setUserStatus(userId, status) {
  return unwrap(await supabase.rpc('admin_set_status', { p_user_id: userId, p_status: status }));
}

/**
 * Delete an account. Its pages are TRANSFERRED to the acting
 * administrator rather than deleted — removing a person should not
 * silently destroy documentation other people are reading.
 *
 * Returns { email, username, pages_transferred }.
 */
export async function deleteUser(userId) {
  return unwrap(await supabase.rpc('admin_delete_user', { p_user_id: userId }));
}
