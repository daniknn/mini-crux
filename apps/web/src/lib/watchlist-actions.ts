/**
 * The contract between the watchlist forms and whatever performs the write.
 *
 * It lives here, in neither of them, for one reason: `views/watchlist-forms.tsx` is a client
 * component and `app/(dashboard)/listas/actions.ts` is `'use server'` and reaches Postgres.
 * Either one importing the other's types would be a type-only edge that a reader has to
 * verify is type-only, and the `/ux` preview's isolation rule (UC-10) would rest on that
 * verification. A third module with no runtime at all removes the question.
 */

export interface ActionResult {
  ok: boolean
  /** Mexican Spanish, shown directly to the operator. */
  message: string
}

/** The `useActionState` reducer shape every watchlist write conforms to. */
export type WatchlistAction = (
  previous: ActionResult | null,
  form: FormData,
) => Promise<ActionResult>
