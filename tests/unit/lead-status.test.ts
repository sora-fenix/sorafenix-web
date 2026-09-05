import { describe, expect, it } from 'vitest'

import {
  type LeadStatus,
  LEAD_STATUSES,
  TERMINAL_STATUSES,
  allowedTransitions,
  canTransition,
  isLeadStatus,
  isTerminal,
  nextInChain,
  refuseTransition,
} from '@/lib/crm/transitions'

/**
 * The status graph decides what the pipeline is allowed to claim happened. A move
 * that should have been refused becomes a lead marked "contacted" that nobody
 * contacted, and the activity trail then documents a fiction.
 */

const CHAIN: readonly LeadStatus[] = [
  'new',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'meeting',
  'proposal',
  'negotiation',
  'won',
]

describe('the status set', () => {
  it('matches the eleven statuses in SPEC §1', () => {
    expect([...LEAD_STATUSES]).toEqual([
      'new', 'qualified', 'contacted', 'replied', 'interested', 'meeting',
      'proposal', 'negotiation', 'won', 'lost', 'do_not_contact',
    ])
  })

  it('has exactly three terminal states', () => {
    expect([...TERMINAL_STATUSES]).toEqual(['won', 'lost', 'do_not_contact'])
    for (const status of LEAD_STATUSES) {
      expect(isTerminal(status)).toBe(TERMINAL_STATUSES.includes(status))
    }
  })
})

describe('advancing one step', () => {
  it('walks the chain in SPEC order', () => {
    for (let i = 0; i < CHAIN.length - 1; i += 1) {
      const from = CHAIN[i]
      const to = CHAIN[i + 1]
      if (from === undefined || to === undefined) throw new Error('bad chain fixture')
      expect(nextInChain(from)).toBe(to)
      expect(canTransition(from, to)).toBe(true)
    }
  })

  it('ends the chain at won', () => {
    expect(nextInChain('won')).toBe(null)
  })

  it('is the move scoring makes', () => {
    expect(canTransition('new', 'qualified')).toBe(true)
  })
})

describe('what is refused', () => {
  it('refuses skipping ahead', () => {
    // A lead marked contacted without ever being qualified is usually a send that
    // ran before scoring, not a salesperson being efficient.
    expect(refuseTransition('new', 'contacted')).toBe('not_allowed')
    expect(refuseTransition('new', 'won')).toBe('not_allowed')
    expect(refuseTransition('qualified', 'meeting')).toBe('not_allowed')
  })

  it('refuses going backwards', () => {
    expect(refuseTransition('contacted', 'qualified')).toBe('not_allowed')
    expect(refuseTransition('meeting', 'new')).toBe('not_allowed')
  })

  it('refuses a move that changes nothing', () => {
    // Not an error the caller can ignore: it means they did not check, and the
    // activity row would read "qualified → qualified".
    for (const status of LEAD_STATUSES) {
      expect(refuseTransition(status, status)).toBe('unchanged')
    }
  })

  it('refuses anything at all out of a terminal state', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of LEAD_STATUSES) {
        if (target === terminal) continue
        expect(refuseTransition(terminal, target)).toBe('terminal')
      }
      expect(allowedTransitions(terminal)).toEqual([])
    }
  })
})

describe('the escape hatches', () => {
  it('lets a deal die at any stage', () => {
    for (const status of LEAD_STATUSES) {
      if (isTerminal(status)) continue
      expect(canTransition(status, 'lost')).toBe(true)
    }
  })

  it('honours do_not_contact immediately, from anywhere', () => {
    // .claude/rules/outreach.md: a "STOP" reply stops everything at once. A graph
    // that made opt-out wait its turn would keep sending in the meantime.
    for (const status of LEAD_STATUSES) {
      if (isTerminal(status)) continue
      expect(canTransition(status, 'do_not_contact')).toBe(true)
    }
  })

  it('offers the next step plus both escapes, and nothing else', () => {
    expect(allowedTransitions('new')).toEqual(['qualified', 'lost', 'do_not_contact'])
    expect(allowedTransitions('negotiation')).toEqual(['won', 'lost', 'do_not_contact'])
  })
})

describe('isLeadStatus', () => {
  it('accepts every real status', () => {
    for (const status of LEAD_STATUSES) {
      expect(isLeadStatus(status)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isLeadStatus('Qualified')).toBe(false)
    expect(isLeadStatus('nurturing')).toBe(false)
    expect(isLeadStatus('')).toBe(false)
  })
})
