/**
 * Stands in for the `server-only` package inside the integration suite.
 *
 * `server-only` throws on import unless the resolver picks its `react-server`
 * condition, which only the Next build does. Vitest runs plain Node, so every
 * module that guards itself with it — lib/db/drizzle.ts, lib/db/admin.ts,
 * lib/leads/ingest.ts — would be unimportable here.
 *
 * Aliasing it away is safe precisely because the guard is a build-time boundary:
 * it exists to stop a client bundle from pulling server code in, and this suite
 * produces no bundle. The real guard still protects the real app.
 */
export {}
