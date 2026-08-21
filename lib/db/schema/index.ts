/**
 * Schema barrel. Import from `@/lib/db/schema`, never from a domain file directly,
 * so the split stays an implementation detail.
 *
 * Dependency order is strict and acyclic:
 *
 *   workspace  ←  crm  ←  outreach
 *        ↖ ai
 *
 * A domain file may only import from files to its left. If you find yourself
 * needing the other direction, the table is in the wrong file.
 */

export * from './workspace'
export * from './crm'
export * from './outreach'
export * from './ai'
