import { z } from 'zod'

/**
 * Single source of truth for environment variables (CLAUDE.md rule 1).
 * Nothing else in the codebase may read `process.env` directly.
 *
 * Two schemas live here:
 *  - `publicEnvSchema` — NEXT_PUBLIC_* only. Next inlines these into the client
 *    bundle, so they are parsed eagerly on both server and client.
 *  - `serverEnvSchema` — everything else. Exposed through `serverEnv()` rather than
 *    a bare const, because this module is also imported by client components (for
 *    `publicEnv`) where server variables are legitimately absent. Boot-time
 *    validation happens in `instrumentation.ts`, which calls `serverEnv()` on start.
 *
 * Integration keys (Gmail / WhatsApp / LLM) are `.optional()` for now and become
 * required in the phase that builds the module needing them. See docs/PROGRESS.md.
 */

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

// Without this, the WHATWG parser reads "localhost:3000" as scheme "localhost".
const HTTP_PROTOCOL = /^https?$/

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    protocol: HTTP_PROTOCOL,
    error: 'NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL',
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string({ error: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required' })
    .min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY must not be empty'),
  NEXT_PUBLIC_APP_URL: z.url({
    protocol: HTTP_PROTOCOL,
    error: 'NEXT_PUBLIC_APP_URL must be an http(s) URL, e.g. http://localhost:3000',
  }),
})

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Core: required to boot ------------------------------------------------
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL must not be empty')
    .startsWith('postgres', 'DATABASE_URL must be a postgres:// connection string'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ error: 'SUPABASE_SERVICE_ROLE_KEY is required' })
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY must not be empty'),
  N8N_WEBHOOK_SECRET: z
    .string({ error: 'N8N_WEBHOOK_SECRET is required' })
    .min(32, 'N8N_WEBHOOK_SECRET must be at least 32 characters'),

  // --- Integrations: declared now, required when their module ships -----------
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),

  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  GMAIL_REDIRECT_URI: z.url({ protocol: HTTP_PROTOCOL }).optional(),

  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),

  SERPER_API_KEY: z.string().min(1).optional(),
})

export type PublicEnv = z.infer<typeof publicEnvSchema>
export type ServerEnv = z.infer<typeof serverEnvSchema>

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

function formatIssues(scope: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join('.')
    return `  - ${path === '' ? '(root)' : path}: ${issue.message}`
  })
  return [
    `Invalid ${scope} environment variables:`,
    ...lines,
    '',
    'Copy .env.example to .env.local and fill in the missing values.',
  ].join('\n')
}

/** Exported so tests can exercise the schema without touching `process.env`. */
export function parsePublicEnv(source: Record<string, unknown>): PublicEnv {
  const result = publicEnvSchema.safeParse(source)
  if (!result.success) {
    throw new Error(formatIssues('public', result.error))
  }
  return result.data
}

/** Exported so tests can exercise the schema without touching `process.env`. */
export function parseServerEnv(source: Record<string, unknown>): ServerEnv {
  const result = serverEnvSchema.safeParse(source)
  if (!result.success) {
    throw new Error(formatIssues('server', result.error))
  }
  return result.data
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

// Next only substitutes NEXT_PUBLIC_* when written as a static property access,
// so these cannot be read through a dynamic `process.env[key]` lookup.
export const publicEnv: PublicEnv = parsePublicEnv({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
})

let cachedServerEnv: ServerEnv | undefined

/**
 * Validated server environment. Throws if called from the browser — server
 * variables are deliberately not in the client bundle.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv() was called in the browser. Server-only variables are not bundled ' +
        'for the client; use publicEnv instead.',
    )
  }
  cachedServerEnv ??= parseServerEnv(process.env)
  return cachedServerEnv
}
