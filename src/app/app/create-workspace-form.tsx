'use client'

import { Building2 } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { createWorkspace, type CreateWorkspaceState } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const INITIAL: CreateWorkspaceState = { status: 'idle', message: '' }

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Membuat…' : 'Buat workspace'}
    </Button>
  )
}

export function CreateWorkspaceForm() {
  const [state, formAction] = useActionState(createWorkspace, INITIAL)

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Nama perusahaan Anda</Label>
        <Input
          id="name"
          name="name"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          placeholder="PT Maju Bersama Digital"
          aria-describedby={state.status === 'error' ? 'workspace-error' : 'workspace-hint'}
          aria-invalid={state.status === 'error'}
        />
        <p id="workspace-hint" className="text-muted-foreground text-xs">
          Nama ini yang muncul di seluruh aplikasi. Bisa diubah nanti di Pengaturan.
        </p>
      </div>

      {state.status === 'error' ? (
        <p id="workspace-error" role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      ) : null}

      <SubmitButton />

      <p className="text-muted-foreground flex items-start gap-2 text-xs">
        <Building2 className="mt-0.5 size-3.5 shrink-0" />
        Anda otomatis menjadi pemilik workspace ini dan bisa mengundang tim setelahnya.
      </p>
    </form>
  )
}
