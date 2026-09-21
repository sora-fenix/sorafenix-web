/**
 * Role → action matrix. Pure, no I/O, no imports — so it is cheap to unit test
 * and safe to call from anywhere, including client components rendering nav.
 *
 * Roles come from docs/SPEC.md §1 (`memberships.role`).
 */

export const ROLES = ['owner', 'manager', 'sales', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const ACTIONS = [
  'workspace:manage', // rename, plan, sending limits, hard-delete
  /**
   * Add someone to the workspace. Split from `member:manage` on 2026-09-21 so a
   * manager can staff their own team without also being able to change roles —
   * which is what let a manager promote themselves to owner and demote the real
   * one before `drizzle/0012`. A manager may not invite at `owner`; the RLS
   * policy enforces that half, since the matrix cannot see the role being granted.
   */
  'member:invite',
  'member:manage', // change an existing member's role, remove a member
  'campaign:manage', // create, pause, edit targeting
  'knowledge:manage', // upload and edit knowledge_docs
  'lead:write', // edit lead fields, reassign owner
  'message:approve', // approve or reject an AI draft
  'message:send', // trigger an actual outbound send
  'data:export', // export contact data (UU PDP obligation)
] as const
export type Action = (typeof ACTIONS)[number]

const OWNER_ACTIONS: readonly Action[] = ACTIONS

const MANAGER_ACTIONS: readonly Action[] = [
  'member:invite',
  'campaign:manage',
  'knowledge:manage',
  'lead:write',
  'message:approve',
  'message:send',
  'data:export',
]

const SALES_ACTIONS: readonly Action[] = ['lead:write', 'message:send']

const VIEWER_ACTIONS: readonly Action[] = []

const MATRIX: Record<Role, readonly Action[]> = {
  owner: OWNER_ACTIONS,
  manager: MANAGER_ACTIONS,
  sales: SALES_ACTIONS,
  viewer: VIEWER_ACTIONS,
}

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action)
}

export function isRole(value: string): value is Role {
  return ROLES.some((role) => role === value)
}

/** Human-readable role names for the UI (Bahasa Indonesia). */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Pemilik',
  manager: 'Manajer',
  sales: 'Sales',
  viewer: 'Peninjau',
}
