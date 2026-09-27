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
    // The WAHA webhook secret the suite signs its own requests with. A throwaway
    // value, the way `vitest.config.ts` gives the unit suite its NEXT_PUBLIC_*: the
    // inbound route refuses everything when the secret is unset, and requiring a
    // developer to put one in .env.local before `pnpm test:integration` passes would
    // make the suite fail for a reason that has nothing to do with the code.
    env: {
      WAHA_WEBHOOK_HMAC_SECRET: 'integration-suite-waha-hmac-secret-0123456789',
    },
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
