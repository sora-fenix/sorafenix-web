'use client'

import { CheckCircle2, Mail } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { requestMagicLink, type MagicLinkState } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const INITIAL: MagicLinkState = { status: 'idle', message: '' }

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Mengirim…' : 'Kirim tautan masuk'}
    </Button>
  )
}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(requestMagicLink, INITIAL)

  if (state.status === 'sent') {
    return (
      <div className="rounded-lg border border-dashed px-5 py-8 text-center">
        <CheckCircle2 className="text-muted-foreground mx-auto mb-3 size-6" />
        <p className="text-sm font-medium">Cek email Anda</p>
        <p className="text-muted-foreground mt-1.5 text-sm">{state.message}</p>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />

      <div className="space-y-2">
        <Label htmlFor="email">Email kerja</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="nama@perusahaan.co.id"
          aria-describedby={state.status === 'error' ? 'login-error' : undefined}
          aria-invalid={state.status === 'error'}
        />
      </div>

      {state.status === 'error' ? (
        <p id="login-error" role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      ) : null}

      <SubmitButton />

      <p className="text-muted-foreground flex items-start gap-2 text-xs">
        <Mail className="mt-0.5 size-3.5 shrink-0" />
        Kami mengirim tautan sekali pakai. Tidak ada kata sandi yang perlu Anda ingat.
      </p>
    </form>
  )
}
