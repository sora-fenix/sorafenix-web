import { describe, expect, it } from 'vitest'

import {
  ackToStatus,
  createWahaTransport,
  fromChatId,
  isEcho,
  resolveSessionWorkspace,
  statusesBelow,
  toChatId,
} from '@/lib/outreach/whatsapp'

/**
 * The WhatsApp transport layer: the address format, the ack ladder, the session →
 * workspace resolution, and the WAHA adapter driven against a fake fetch.
 *
 * The owner has no WAHA instance yet, so the adapter is proved the way `draft.ts`
 * proves the model — by injection. What that settles is the request we build (URL,
 * header name, body shape, chat id) and what we do with each answer. What it cannot
 * settle is whether a real WAHA accepts it; see the note in docs.
 *
 * The session resolver is the tenant-isolation decision in this slice, so its two
 * refusals — no workspace, more than one workspace — matter more than its success
 * case. A number is never the tenant key.
 */

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'

describe('toChatId', () => {
  it('drops the plus and appends WAHA’s person suffix', () => {
    expect(toChatId('+628123456789')).toBe('628123456789@c.us')
  })

  // The same conversation reached us in four spellings during ingest. Two chat ids
  // for one person would be two messages to one person.
  it('normalises every shape of the same number to one chat id', () => {
    const expected = '6281234567890@c.us'
    expect(toChatId('081234567890')).toBe(expected)
    expect(toChatId('+62 812-3456-7890')).toBe(expected)
    expect(toChatId('0062 81234567890')).toBe(expected)
    expect(toChatId('6281234567890')).toBe(expected)
  })

  it('refuses a landline, which cannot receive WhatsApp', () => {
    expect(toChatId('+62315012345')).toBeNull()
  })

  it('refuses nothing at all', () => {
    expect(toChatId(null)).toBeNull()
    expect(toChatId('')).toBeNull()
    expect(toChatId('not a number')).toBeNull()
  })
})

describe('fromChatId', () => {
  it('reads a person’s chat id back to E.164', () => {
    expect(fromChatId('628123456789@c.us')).toBe('+628123456789')
  })

  // A group is not a contact. Attributing its traffic to whichever member's number
  // appears in it would file a stranger's message against a lead.
  it('refuses a group chat id', () => {
    expect(fromChatId('628123456789-1600000000@g.us')).toBeNull()
  })

  it('refuses anything that is not a chat id', () => {
    expect(fromChatId(null)).toBeNull()
    expect(fromChatId('628123456789')).toBeNull()
    expect(fromChatId('status@broadcast')).toBeNull()
  })
})

describe('isEcho', () => {
  it('reads WAHA’s own flag', () => {
    expect(isEcho({ id: 'false_628@c.us_A', fromMe: true })).toBe(true)
    expect(isEcho({ id: 'false_628@c.us_A', fromMe: false })).toBe(false)
  })

  // WhatsApp Web ids are `<fromMe>_<chatId>_<id>`, so the prefix says it even when the
  // flag is absent.
  it('reads the message id when the flag is absent', () => {
    expect(isEcho({ id: 'true_628123456789@c.us_ABC' })).toBe(true)
    expect(isEcho({ id: 'false_628123456789@c.us_ABC' })).toBe(false)
  })

  it('treats an id in neither shape as somebody else’s message', () => {
    expect(isEcho({ id: 'ABC123' })).toBe(false)
  })
})

describe('ackToStatus', () => {
  it('maps WAHA’s codes onto our message statuses', () => {
    expect(ackToStatus(-1)).toBe('failed')
    expect(ackToStatus(0)).toBeNull()
    expect(ackToStatus(1)).toBe('sent')
    expect(ackToStatus(2)).toBe('delivered')
    expect(ackToStatus(3)).toBe('opened')
    // PLAYED, for voice notes we never send.
    expect(ackToStatus(4)).toBe('opened')
  })

  it('ignores a code it has never seen rather than picking a status', () => {
    expect(ackToStatus(9)).toBeNull()
    expect(ackToStatus(-7)).toBeNull()
  })
})

describe('statusesBelow', () => {
  // Acks arrive out of order. A late `delivered` must not walk a replied message back.
  it('lets an ack overwrite only earlier delivery states', () => {
    expect(statusesBelow('delivered')).toEqual(['queued', 'sent'])
    expect(statusesBelow('opened')).toEqual(['queued', 'sent', 'delivered'])
  })

  it('lets a failure land on any live outbound status', () => {
    expect(statusesBelow('failed')).toEqual(['queued', 'sent', 'delivered'])
  })

  it('has nothing for the first rung, so an ack cannot resurrect a message', () => {
    expect(statusesBelow('queued')).toEqual([])
    expect(statusesBelow('draft')).toEqual([])
    expect(statusesBelow('rejected')).toEqual([])
    expect(statusesBelow('pending_approval')).toEqual([])
  })

  it('never contains the status being applied', () => {
    for (const status of ['sent', 'delivered', 'opened', 'replied'] as const) {
      expect(statusesBelow(status)).not.toContain(status)
    }
  })
})

describe('resolveSessionWorkspace', () => {
  const lookupOf = (owners: Record<string, readonly string[]>) => {
    return async (session: string): Promise<readonly string[]> => owners[session] ?? []
  }

  it('returns the one workspace that registered the session', async () => {
    const result = await resolveSessionWorkspace('data-riil', lookupOf({ 'data-riil': [WS_A] }))
    expect(result).toEqual({ ok: true, value: WS_A })
  })

  it('refuses a session no workspace has registered', async () => {
    const result = await resolveSessionWorkspace('ghost', lookupOf({ 'data-riil': [WS_A] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('unknown_session')
  })

  // Migration 0018 makes this unreachable. The resolver still refuses, because the
  // failure it would otherwise cause is one tenant reading another's conversations.
  it('refuses rather than picking when two workspaces claim one session', async () => {
    const result = await resolveSessionWorkspace('default', lookupOf({ default: [WS_A, WS_B] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ambiguous_session')
  })

  it('asks about the session it was given, never about a phone number', async () => {
    const asked: string[] = []
    await resolveSessionWorkspace('data-riil', async (session) => {
      asked.push(session)
      return [WS_A]
    })
    expect(asked).toEqual(['data-riil'])
  })
})

// -----------------------------------------------------------------------------
// The WAHA adapter, against a fake fetch
// -----------------------------------------------------------------------------

type Call = { url: string; init: RequestInit | undefined }

function fakeFetch(respond: (call: Call) => Response): {
  calls: Call[]
  fetch: typeof globalThis.fetch
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const call = { url: String(input), init }
      calls.push(call)
      return respond(call)
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const REQUEST = {
  account: 'data-riil',
  to: '+628123456789',
  text: 'Halo Pak Budi',
  idempotencyKey: 'wa:send:1',
}

describe('createWahaTransport', () => {
  it('posts sendText with the session, the chat id and the text', async () => {
    const fake = fakeFetch(() => json({ id: 'true_628123456789@c.us_ABCDEF' }))
    const transport = createWahaTransport({
      baseUrl: 'http://localhost:3001',
      apiKey: 'secret-key',
      fetch: fake.fetch,
    })

    const result = await transport.send(REQUEST)

    expect(result).toEqual({
      ok: true,
      value: { providerMessageId: 'true_628123456789@c.us_ABCDEF', unparsedResponse: null },
    })
    expect(transport.provider).toBe('waha')

    const call = fake.calls[0]
    if (call === undefined) throw new Error('the transport made no request')
    expect(fake.calls).toHaveLength(1)
    expect(call.url).toBe('http://localhost:3001/api/sendText')
    expect(call.init?.method).toBe('POST')
    expect(call.init?.headers).toMatchObject({ 'x-api-key': 'secret-key' })
    expect(call.init?.body).toBe(
      JSON.stringify({ session: 'data-riil', chatId: '628123456789@c.us', text: 'Halo Pak Budi' }),
    )
  })

  it('does not double the slash when the base URL has a trailing one', async () => {
    const fake = fakeFetch(() => json({ id: 'x' }))
    const transport = createWahaTransport({
      baseUrl: 'http://localhost:3001/',
      apiKey: 'k',
      fetch: fake.fetch,
    })

    await transport.send(REQUEST)
    expect(fake.calls[0]?.url).toBe('http://localhost:3001/api/sendText')
  })

  it('reads the id out of WhatsApp Web’s object form too', async () => {
    const fake = fakeFetch(() => json({ id: { fromMe: true, _serialized: 'true_62_XYZ' } }))
    const transport = createWahaTransport({ baseUrl: 'http://waha', apiKey: 'k', fetch: fake.fetch })

    const result = await transport.send(REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providerMessageId).toBe('true_62_XYZ')
    expect(result.value.unparsedResponse).toBeNull()
  })

  // The message is already on its way. Reporting a failure here would invite a
  // resend, which is a second message to a customer. But an ack can never match a null
  // id, so the row freezes at `sent` — the response is carried back for the audit row
  // to hold, which is the only thing a human can reconcile against.
  it('treats an unreadable success body as sent with no id, not as a failure', async () => {
    for (const body of ['not json', '{}', '{"id":null}', '{"id":{}}']) {
      const fake = fakeFetch(() => new Response(body, { status: 201 }))
      const transport = createWahaTransport({
        baseUrl: 'http://waha',
        apiKey: 'k',
        fetch: fake.fetch,
      })

      const result = await transport.send(REQUEST)
      expect(result).toEqual({
        ok: true,
        value: { providerMessageId: null, unparsedResponse: { status: 201, body } },
      })
    }
  })

  it('reports a provider refusal with its status', async () => {
    const fake = fakeFetch(() => json({ error: 'session not found' }, 422))
    const transport = createWahaTransport({ baseUrl: 'http://waha', apiKey: 'k', fetch: fake.fetch })

    const result = await transport.send(REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('rejected')
    if (result.error.kind !== 'rejected') return
    expect(result.error.status).toBe(422)
    expect(result.error.detail).toContain('session not found')
  })

  it('reports an unreachable bridge as a network failure', async () => {
    const transport = createWahaTransport({
      baseUrl: 'http://waha',
      apiKey: 'k',
      fetch: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
      },
    })

    const result = await transport.send(REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('network')
    if (result.error.kind !== 'network') return
    expect(result.error.detail).toContain('ECONNREFUSED')
  })

  it('makes no request at all for a number WhatsApp cannot reach', async () => {
    const fake = fakeFetch(() => json({ id: 'x' }))
    const transport = createWahaTransport({ baseUrl: 'http://waha', apiKey: 'k', fetch: fake.fetch })

    const result = await transport.send({ ...REQUEST, to: '+62315012345' })
    expect(result.ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })
})
