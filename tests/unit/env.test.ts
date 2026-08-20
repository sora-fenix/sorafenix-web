import { describe, expect, it } from 'vitest'

import { parsePublicEnv, parseServerEnv } from '@/lib/env'

const VALID_SERVER = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  N8N_WEBHOOK_SECRET: 'a'.repeat(32),
}

const VALID_PUBLIC = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
}

describe('parseServerEnv', () => {
  it('accepts a complete core configuration', () => {
    const env = parseServerEnv(VALID_SERVER)
    expect(env.DATABASE_URL).toBe(VALID_SERVER.DATABASE_URL)
    expect(env.NODE_ENV).toBe('test')
  })

  it('leaves integration keys undefined until their module ships', () => {
    const env = parseServerEnv(VALID_SERVER)
    expect(env.GMAIL_CLIENT_ID).toBeUndefined()
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeUndefined()
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined()
  })

  it('throws when a required core variable is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = VALID_SERVER
    expect(() => parseServerEnv(withoutDatabaseUrl)).toThrowError(/DATABASE_URL/)
  })

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() =>
      parseServerEnv({ ...VALID_SERVER, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrowError(/postgres/)
  })

  it('rejects a webhook secret that is too short to be meaningful', () => {
    expect(() =>
      parseServerEnv({ ...VALID_SERVER, N8N_WEBHOOK_SECRET: 'short' }),
    ).toThrowError(/N8N_WEBHOOK_SECRET/)
  })

  it('defaults NODE_ENV to development when absent', () => {
    const { NODE_ENV: _omitted, ...withoutNodeEnv } = VALID_SERVER
    expect(parseServerEnv(withoutNodeEnv).NODE_ENV).toBe('development')
  })
})

describe('parsePublicEnv', () => {
  it('accepts a complete configuration', () => {
    expect(parsePublicEnv(VALID_PUBLIC).NEXT_PUBLIC_APP_URL).toBe(
      'http://localhost:3000',
    )
  })

  it('rejects a non-URL app URL', () => {
    expect(() =>
      parsePublicEnv({ ...VALID_PUBLIC, NEXT_PUBLIC_APP_URL: 'localhost:3000' }),
    ).toThrowError(/NEXT_PUBLIC_APP_URL/)
  })

  it('names every missing variable in one error', () => {
    expect(() => parsePublicEnv({})).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/)
    expect(() => parsePublicEnv({})).toThrowError(/NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })
})
