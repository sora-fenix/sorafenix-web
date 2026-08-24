'use server'

import { z } from 'zod'

import { publicEnv } from '@/lib/env'
import { createSupabaseServerClient } from '@/lib/db/server'

const requestSchema = z.object({
  email: z.email('Masukkan alamat email yang valid.'),
  // Where to send the user after they click the link. Relative paths only, so a
  // crafted ?next= cannot turn the magic link into an open redirect.
  next: z
    .string()
    .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
      message: 'Tujuan tidak valid.',
    })
    .default('/app'),
})

export type MagicLinkState = {
  status: 'idle' | 'sent' | 'error'
  message: string
}

export async function requestMagicLink(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const parsed = requestSchema.safeParse({
    email: formData.get('email'),
    next: formData.get('next') ?? '/app',
  })

  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      status: 'error',
      message: first?.message ?? 'Data yang Anda masukkan tidak valid.',
    }
  }

  const supabase = await createSupabaseServerClient()
  const callback = new URL('/auth/callback', publicEnv.NEXT_PUBLIC_APP_URL)
  callback.searchParams.set('next', parsed.data.next)

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callback.toString() },
  })

  if (error !== null) {
    console.error('signInWithOtp failed', error)
    return {
      status: 'error',
      message: 'Gagal mengirim tautan masuk. Coba lagi dalam beberapa saat.',
    }
  }

  return {
    status: 'sent',
    message: `Tautan masuk sudah dikirim ke ${parsed.data.email}. Cek kotak masuk Anda, tautan berlaku 1 jam.`,
  }
}
