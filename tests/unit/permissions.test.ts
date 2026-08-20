import { describe, expect, it } from 'vitest'

import { ACTIONS, ROLES, can, isRole } from '@/lib/auth/permissions'

describe('can', () => {
  it('gives the owner every action', () => {
    for (const action of ACTIONS) {
      expect(can('owner', action)).toBe(true)
    }
  })

  it('gives the viewer no action at all', () => {
    for (const action of ACTIONS) {
      expect(can('viewer', action)).toBe(false)
    }
  })

  it('lets a manager approve drafts but not manage members', () => {
    expect(can('manager', 'message:approve')).toBe(true)
    expect(can('manager', 'member:manage')).toBe(false)
    expect(can('manager', 'workspace:manage')).toBe(false)
  })

  it('lets sales work leads and send, but never approve their own drafts', () => {
    expect(can('sales', 'lead:write')).toBe(true)
    expect(can('sales', 'message:send')).toBe(true)
    expect(can('sales', 'message:approve')).toBe(false)
  })

  it('restricts data export to owner and manager (UU PDP obligation)', () => {
    expect(can('owner', 'data:export')).toBe(true)
    expect(can('manager', 'data:export')).toBe(true)
    expect(can('sales', 'data:export')).toBe(false)
    expect(can('viewer', 'data:export')).toBe(false)
  })

  it('resolves an answer for every role/action pair', () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(typeof can(role, action)).toBe('boolean')
      }
    }
  })
})

describe('isRole', () => {
  it('accepts the four known roles', () => {
    expect(ROLES.every((role) => isRole(role))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isRole('admin')).toBe(false)
    expect(isRole('')).toBe(false)
    expect(isRole('OWNER')).toBe(false)
  })
})
