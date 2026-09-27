/**
 * Sends one approved WhatsApp message, through the real send path.
 *
 *   pnpm wa:send 0f2c1a9e-4b7d-4f1a-9c3e-7d5b8a2e6f10
 *
 * A command rather than a button, the same reason `score:leads` is one: the send
 * path has to be provable before there is a UI on top of it, and a script that
 * prints the guard's verdict is the shortest honest way to see what would happen to
 * a real message.
 *
 * It calls `sendMessage`, which asks `send-guard.ts` first, every time. There is no
 * `--force`, there is no `--skip-guard`, and adding one would be a bypass of
 * CLAUDE.md rule 4. If this prints a rejection, the rejection is the answer: fix the
 * message or wait for the window.
 *
 * Requires WAHA to be running and reachable at WAHA_BASE_URL, and the workspace to
 * have been through `pnpm wa:connect`. With no WAHA instance it reports
 * `transport_not_configured` or a `network` failure and writes the attempt to the
 * activity trail as `message_failed` — the message is left at `failed`, not silently
 * retried.
 *
 * `--conditions=react-server` in the package.json script is load-bearing: the
 * modules below import `server-only`, whose default export throws outside a server
 * runtime. The condition resolves it to the package's own empty module.
 */

import { config } from 'dotenv'
import postgres from 'postgres'

import type { SendMessageError } from '../src/lib/outreach/send'

config({ path: '.env.local', quiet: true })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const messageId = process.argv[2]
  if (messageId === undefined || !UUID.test(messageId)) {
    console.error('Usage: pnpm wa:send <messageId>')
    console.error('')
    console.error('Find one with:')
    console.error("  select id, status, channel from messages where channel = 'whatsapp';")
    process.exitCode = 1
    return
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} })

  try {
    // The script is given an id and nothing else, so the workspace has to come from
    // the row. Everything after this point is workspace-scoped.
    const [message] = await sql<
      { workspaceId: string; slug: string; status: string; channel: string }[]
    >`
      select m.workspace_id as "workspaceId", w.slug, m.status, m.channel
      from messages m
      join workspaces w on w.id = m.workspace_id
      where m.id = ${messageId}`

    if (message === undefined) {
      console.error(`No message with id ${messageId}.`)
      process.exitCode = 1
      return
    }

    console.log(`Message ${messageId}`)
    console.log(`  workspace  ${message.slug}`)
    console.log(`  channel    ${message.channel}`)
    console.log(`  status     ${message.status}`)
    console.log('')

    const { sendMessage } = await import('../src/lib/outreach/send')

    const result = await sendMessage({
      workspaceId: message.workspaceId,
      messageId,
      // Deterministic per message, so running this twice cannot look like two
      // different sends in the activity trail. What actually stops the second send
      // is the status claim in send.ts.
      idempotencyKey: `wa:send:${messageId}`,
    })

    if (!result.ok) {
      console.log(`NOT SENT — ${result.error.kind}`)
      console.log(`  ${detail(result.error)}`)
      process.exitCode = 1
      return
    }

    console.log('SENT')
    console.log(`  to          ${result.value.recipient}`)
    console.log(`  provider    ${result.value.provider}`)
    console.log(`  provider id ${result.value.providerMessageId ?? '(none returned)'}`)
    console.log(`  sent at     ${result.value.sentAt.toISOString()}`)
  } finally {
    await sql.end()
    await globalThis.__soraPostgresClient?.end()
  }
}

/** One line a human can act on, whatever the failure was. */
function detail(error: SendMessageError): string {
  switch (error.kind) {
    case 'rejected_by_guard': {
      const rejection = error.error
      if ('reason' in rejection) {
        const retry = rejection.retryAt
        const when = retry === null ? '' : ` (bisa dicoba lagi ${retry.toISOString()})`
        return `${rejection.kind}: ${rejection.reason}${when}`
      }
      if (rejection.kind === 'guard_failed') return `guard_failed: ${rejection.message}`
      return rejection.kind
    }
    case 'channel_not_implemented':
      return `${error.channel} has no transport yet; this slice is WhatsApp only`
    case 'transport_not_configured':
      return `missing in .env.local: ${error.missing.join(', ')}`
    case 'not_connected':
      return `${error.detail} — run \`pnpm wa:connect --workspace <slug>\``
    case 'already_claimed':
      return `status is now ${error.status}, so nothing was sent`
    case 'send_failed':
      return (
        `${error.error.kind}: ${error.error.detail}` +
        (error.recorded ? '' : ' (and the failure itself could not be written — row still queued)')
      )
    case 'load_failed':
      return `nothing was sent; the database said: ${error.message}`
    case 'outcome_unknown':
      // The one failure that must not be retried blindly.
      return (
        `the message MAY have been delivered and the row is still queued — ${error.message}. ` +
        `Check WAHA's own message list for ${error.providerMessageId ?? 'this chat'} before resending.`
      )
    default:
      return ''
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
