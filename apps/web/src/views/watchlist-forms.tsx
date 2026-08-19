'use client'

import { useActionState } from 'react'

import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import type { ActionResult, WatchlistAction } from '../lib/watchlist-actions.ts'

/**
 * The only client components in the dashboard.
 *
 * Every other surface is a server component with link-based state, because a filter does not
 * need JavaScript. These do: a form that reports "no encontramos esa lista" has to render the
 * result of a write, and `useActionState` is how that arrives without an ad-hoc fetch.
 *
 * The pending state is not decoration either. A watchlist write goes to Postgres and back
 * through a `revalidatePath`, which on a cold connection is slow enough for an operator to
 * press twice; disabling the button while it is in flight is what stops the second press
 * creating a duplicate list.
 *
 * WHY THE ACTIONS ARRIVE AS PROPS (UC-10)
 *
 * They used to be imported from `../app/(dashboard)/listas/actions.ts`, which reaches
 * `withWorkspace`, which reaches Clerk and `pg`. That import is what would drag the whole
 * server into the `/ux` preview and make its isolation rule unenforceable. Taking the action
 * as a prop costs one line per form and buys a component that renders identically whether the
 * caller hands it the real write or a stub that politely refuses — which is exactly what the
 * preview needs it to do.
 */

/** Shown under every form. `aria-live` so the outcome reaches a screen reader too. */
function Result({ state }: { state: ActionResult | null }): React.ReactElement {
  return (
    <p
      aria-live="polite"
      className={
        state === null
          ? 'sr-only'
          : state.ok
            ? 'text-xs text-emerald-300'
            : 'text-xs text-red-300'
      }
    >
      {state?.message ?? ''}
    </p>
  )
}

export function CreateWatchlistForm({ action }: { action: WatchlistAction }): React.ReactElement {
  const [state, formAction, pending] = useActionState(action, null)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nombre"
          htmlFor="new-label"
          hint="Cómo la vas a reconocer en esta pantalla."
        >
          <Input id="new-label" name="label" required maxLength={120} placeholder="Bancos MX" />
        </Field>

        <Field label="Tipo" htmlFor="new-kind" hint="Palabra clave busca en todo el país; página vigila a un anunciante.">
          <select
            id="new-kind"
            name="kind"
            defaultValue="keyword"
            className="h-11 w-full rounded-sm border border-input bg-muted px-3 text-sm text-foreground"
          >
            <option value="keyword">Palabra clave</option>
            <option value="page">Página de anunciante</option>
          </select>
        </Field>

        <Field
          label="Qué vigilar"
          htmlFor="new-query"
          hint="La palabra clave, o el identificador de la página de Meta."
        >
          <Input
            id="new-query"
            name="query"
            required
            maxLength={200}
            placeholder="tarjeta de crédito"
          />
        </Field>

        <Field label="País" htmlFor="new-country" hint="Código de dos letras. MX por omisión.">
          <Input id="new-country" name="country" defaultValue="MX" maxLength={2} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creando…' : 'Crear lista'}
        </Button>
        <Result state={state} />
      </div>
    </form>
  )
}

export function RenameWatchlistForm({
  action,
  id,
  label,
}: {
  action: WatchlistAction
  id: string
  label: string
}): React.ReactElement {
  const [state, formAction, pending] = useActionState(action, null)

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          {/* The id is per-watchlist: several of these render on one page, and a duplicated
              `for` attribute points every label at the first input. */}
          <Field label="Nombre" htmlFor={`label-${id}`}>
            <Input id={`label-${id}`} name="label" defaultValue={label} maxLength={120} required />
          </Field>
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Guardando…' : 'Renombrar'}
        </Button>
      </div>
      <Result state={state} />
    </form>
  )
}

export function ToggleWatchlistForm({
  action,
  id,
  isActive,
}: {
  action: WatchlistAction
  id: string
  isActive: boolean
}): React.ReactElement {
  const [state, formAction, pending] = useActionState(action, null)

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant={isActive ? 'ghost' : 'secondary'} disabled={pending}>
          {pending ? 'Guardando…' : isActive ? 'Pausar' : 'Reactivar'}
        </Button>
        {/* Said before the click, not after. "Pausar" next to a delete-shaped button is the
            moment an operator needs to know that nothing is being thrown away. */}
        <span className="text-xs text-muted-foreground">
          {isActive
            ? 'Pausar detiene el rastreo diario. No borra nada.'
            : 'Sin rastrear desde que se pausó. Sus observaciones siguen ahí.'}
        </span>
      </div>
      <Result state={state} />
    </form>
  )
}

export function StatusBadge({
  status,
}: {
  status: string | null
}): React.ReactElement {
  if (status === null) return <Badge variant="neutral">Sin rastrear todavía</Badge>
  if (status === 'succeeded') return <Badge variant="success">Último rastreo sano</Badge>
  if (status === 'suspect') return <Badge variant="warning">Último rastreo dudoso</Badge>
  return <Badge variant="danger">Último rastreo fallido</Badge>
}
