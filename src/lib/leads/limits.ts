/**
 * Bounds shared by every route into lead ingestion.
 *
 * Here rather than in `ingest.ts` because the CSV parser is pure and must stay
 * importable without `server-only`, and here rather than in the n8n route because
 * two intake paths writing into the same tables must not disagree about how big a
 * batch is allowed to be. One number, one place.
 */

/** How many items one batch may carry, whether it arrives signed or uploaded. */
export const MAX_INGEST_ITEMS = 1000

/**
 * The largest upload we will accept, in bytes.
 *
 * **This number is not ours alone.** A CSV reaches us through a server action,
 * and Next rejects a server-action body over `experimental.serverActions
 * .bodySizeLimit` — default `1 MB` — before our code runs at all. A cap of 5 MB
 * here would have been unreachable: the user would get `error.tsx` from a
 * framework 413 instead of the message this product promises them, and the
 * `file_too_large` branch would be dead code in production. So the cap matches
 * the framework's default rather than fighting it, and `next.config.ts` pins the
 * limit explicitly instead of inheriting it, so neither can move on its own.
 *
 * Generous against `MAX_INGEST_ITEMS`: 1000 rows of the export's eighteen columns
 * is roughly 400 KB, so a file that passes the byte check and fails the row check
 * gets the row-count message, which is the one a person can act on.
 */
export const MAX_CSV_UPLOAD_BYTES = 1024 * 1024

/**
 * Room for the multipart envelope, the campaign id and the checkbox that ride
 * along with the file.
 *
 * Without it a file of exactly `MAX_CSV_UPLOAD_BYTES` would exceed the body limit
 * on framing alone, and the user would hit the framework's 413 one byte before
 * our own message — which is the failure this pair exists to prevent.
 */
export const UPLOAD_BODY_HEADROOM_BYTES = 64 * 1024
