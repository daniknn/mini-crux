'use server'

import { newTraceId } from '@mini-crux/core'
import { createWatchlist, renameWatchlist, setWatchlistActive } from '@mini-crux/db/dashboard'
import { revalidatePath } from 'next/cache'

import type { ActionResult } from '../../../lib/watchlist-actions.ts'
import { currentClerkUserId, withWorkspace } from '../../../server/db.ts'

/**
 * Watchlist writes — the only place the dashboard mutates anything.
 *
 * Every action mints a `trace_id` at ingress and stamps the Clerk user as the actor, so the
 * audit row, the logs and any crawl the change later causes all join on one key (DashOne §3).
 * Neither the workspace nor the actor is ever read from the form: they come from the session
 * inside `withWorkspace` and `currentClerkUserId`, so a forged field has nowhere to land.
 *
 * There is deliberately no delete action. `is_active = false` stops the scheduler and leaves
 * every observation in place; deleting would cascade the crawl runs and take months of
 * longitudinal history with it, and that history cannot be backfilled (rule 1). An operator
 * tidying up their lists must not be able to destroy the panel.
 *
 * `ActionResult` lives in `lib/watchlist-actions.ts` rather than here: a `'use server'` module
 * may only export async functions, and the forms that render the result must not import a file
 * that reaches Postgres (UC-10).
 */

const KINDS = new Set(['keyword', 'page'])

export async function createWatchlistAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const kind = String(form.get('kind') ?? '')
  const query = String(form.get('query') ?? '').trim()
  const label = String(form.get('label') ?? '').trim()
  const country = String(form.get('country') ?? 'MX').trim()

  if (!KINDS.has(kind)) return { ok: false, message: 'Selecciona un tipo de lista válido.' }
  if (query === '') return { ok: false, message: 'Escribe la palabra clave o la página a vigilar.' }
  if (label === '') return { ok: false, message: 'Ponle un nombre a la lista.' }

  const traceId = newTraceId()
  const clerkUserId = await currentClerkUserId()

  await withWorkspace((db) =>
    createWatchlist(db, {
      kind: kind as 'keyword' | 'page',
      query,
      label,
      country,
      clerkUserId,
      traceId,
    }),
  )

  revalidatePath('/listas')
  return {
    ok: true,
    message: `Lista "${label}" creada. Empieza a rastrear en el siguiente ciclo diario.`,
  }
}

export async function renameWatchlistAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const id = String(form.get('id') ?? '')
  const label = String(form.get('label') ?? '').trim()

  if (label === '') return { ok: false, message: 'El nombre no puede quedar vacío.' }

  const traceId = newTraceId()
  const clerkUserId = await currentClerkUserId()
  const renamed = await withWorkspace((db) =>
    renameWatchlist(db, { id, label, clerkUserId, traceId }),
  )

  // `false` means RLS filtered the row — someone else's id, or none at all. Reported the same
  // way for both, so the response cannot be used to probe which ids exist.
  if (!renamed) return { ok: false, message: 'No encontramos esa lista.' }

  revalidatePath('/listas')
  return { ok: true, message: 'Nombre actualizado.' }
}

export async function setWatchlistActiveAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const id = String(form.get('id') ?? '')
  const isActive = form.get('isActive') === 'true'

  const traceId = newTraceId()
  const clerkUserId = await currentClerkUserId()
  const updated = await withWorkspace((db) =>
    setWatchlistActive(db, { id, isActive, clerkUserId, traceId }),
  )

  if (!updated) return { ok: false, message: 'No encontramos esa lista.' }

  revalidatePath('/listas')
  return {
    ok: true,
    message: isActive
      ? 'Lista reactivada. Vuelve a rastrear en el siguiente ciclo.'
      : 'Lista pausada. Se conservan todas las observaciones que ya produjo.',
  }
}
