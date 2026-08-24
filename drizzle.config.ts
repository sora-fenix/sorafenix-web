import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs outside the Next.js runtime, so it loads env itself.
config({ path: '.env.local', quiet: true })

const url = process.env.DATABASE_URL
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
}

export default defineConfig({
  schema: './src/lib/db/schema',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
