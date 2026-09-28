import type { NextConfig } from 'next'

import { MAX_CSV_UPLOAD_BYTES, UPLOAD_BODY_HEADROOM_BYTES } from './src/lib/leads/limits'

/**
 * Pinned rather than inherited.
 *
 * Next's default server-action body limit is 1 MB, enforced before any of our
 * code runs. The CSV upload is the only action that carries a file, so the limit
 * and `MAX_CSV_UPLOAD_BYTES` have to agree — otherwise the user meets a framework
 * 413 and `error.tsx` instead of the Bahasa Indonesia message the form promises.
 * Writing it out means the coupling is visible here and in `limits.ts`, and a
 * change to the framework default cannot move it silently.
 */
const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: MAX_CSV_UPLOAD_BYTES + UPLOAD_BODY_HEADROOM_BYTES,
    },
  },
}

export default nextConfig
