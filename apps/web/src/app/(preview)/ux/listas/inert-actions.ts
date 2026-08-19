'use server'

import type { ActionResult } from '../../../../lib/watchlist-actions.ts'

/**
 * The three watchlist writes, refusing.
 *
 * `CreateWatchlistForm` and friends are client components driven by `useActionState`, so they
 * need a real Server Action reference to render at all — a plain function would fail to
 * serialize across the boundary. These are that reference and nothing more: they import
 * nothing, touch nothing, and return the same sentence every time.
 *
 * Which is the whole point. The alternative was to have the preview import the real actions,
 * and those reach `withWorkspace`, which reaches Clerk and `pg` — the exact edge
 * `preview-isolation.test.ts` refuses. The forms are under review here as *forms*: label
 * association, focus order, the 44px targets, how a pending state looks. What they would have
 * written is not part of that.
 */

const REFUSAL: ActionResult = {
  ok: false,
  message:
    'Esta es la vista previa de diseño: los formularios se ven y se navegan, pero no guardan ' +
    'nada porque no hay base de datos detrás.',
}

export async function createWatchlistPreviewAction(): Promise<ActionResult> {
  return REFUSAL
}

export async function renameWatchlistPreviewAction(): Promise<ActionResult> {
  return REFUSAL
}

export async function setWatchlistActivePreviewAction(): Promise<ActionResult> {
  return REFUSAL
}
