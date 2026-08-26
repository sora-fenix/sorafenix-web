import { fileURLToPath } from 'node:url'

import { config } from 'dotenv'
import { defineConfig } from 'vitest/config'

// These tests talk to a real Postgres, so unlike the unit suite they need the
// same environment the app uses. Start the stack first: `pnpm db:start`.
config({ path: '.env.local', quiet: true })

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Seeding rebuilds a shared workspace; parallel files would race on it.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See tests/integration/server-only.stub.ts — without this, every module
      // that guards itself with `server-only` is unimportable under plain Node.
      'server-only': fileURLToPath(
        new URL('./tests/integration/server-only.stub.ts', import.meta.url),
      ),
    },
  },
})
