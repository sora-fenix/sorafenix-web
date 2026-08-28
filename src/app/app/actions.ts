'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { workspaceHref } from '@/components/layout/nav-items'
import { getCurrentUser } from '@/lib/auth/session'
import { type ProvisionError, provisionWorkspace } from '@/lib/workspace/provision'

/**
 * Creates the signed-in user's first workspace.
 *
 * Thin by design: validate, delegate, translate the failure. The decisions live
 * in `lib/workspace/provision.ts` so they are testable without a request
 * (`.claude/rules/structure.md` — a page composes, it does not decide).
 */

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Nama workspace minimal 2 karakter.')
    .max(120, 'Nama workspace maksimal 120 karakter.'),
})

export type CreateWorkspaceState = {
  status: 'idle' | 'error'
  message: string
}

/** Bahasa Indonesia for the user; the machine codes stay in `lib/` (rule 8). */
const ERROR_COPY: Record<ProvisionError, string> = {
  invalid_name: 'Nama workspace tidak valid.',
  slug_exhausted:
    'Nama itu sudah dipakai terlalu banyak workspace. Coba nama yang lebih spesifik.',
  db_error: 'Gagal membuat workspace. Coba lagi dalam beberapa saat.',
}

export async function createWorkspace(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await getCurrentUser()
  if (user === null) redirect('/login?next=/app')

  const parsed = createSchema.safeParse({ name: formData.get('name') })
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      status: 'error',
      message: first?.message ?? 'Data yang Anda masukkan tidak valid.',
    }
  }

  const result = await provisionWorkspace({
    userId: user.id,
    name: parsed.data.name,
  })

  if (!result.ok) {
    return { status: 'error', message: ERROR_COPY[result.error] }
  }

  // Outside the branch above on purpose: redirect() signals by throwing, so it
  // must not sit inside a try/catch or a conditional that swallows it.
  redirect(workspaceHref(result.value.slug, 'dashboard'))
}
