import { WatchlistsView } from '../../../../views/listas.tsx'
import {
  INGESTION_HEALTH,
  INGESTION_HEALTH_EMPTY,
  WATCHLISTS,
} from '../fixtures/watchlists.ts'
import {
  createWatchlistPreviewAction,
  renameWatchlistPreviewAction,
  setWatchlistActivePreviewAction,
} from './inert-actions.ts'

/**
 * `/ux/listas` — the only preview surface with real forms on it.
 *
 * The three writes arrive as props, and here they are the inert versions: submitting one
 * re-renders the form with a Mexican-Spanish sentence saying the preview has no database. The
 * forms themselves are the product's, unchanged — same labels, same `useActionState`, same
 * pending state — because label association, focus order and the 44px targets are exactly what
 * this page exists to let a reviewer check.
 *
 * This is also where the preview's isolation is actually won. The real actions reach
 * `withWorkspace` → Clerk → `pg`; passing them as props rather than importing them is what
 * keeps that edge out of this tree (`specs/UC-10-ux-preview.md` §2).
 */
export default async function PreviewWatchlistsPage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>
}): Promise<React.ReactElement> {
  const { caso } = await searchParams
  const empty = caso === 'vacio'

  return (
    <WatchlistsView
      watchlists={empty ? [] : WATCHLISTS}
      health={empty ? INGESTION_HEALTH_EMPTY : INGESTION_HEALTH}
      actions={{
        create: createWatchlistPreviewAction,
        rename: renameWatchlistPreviewAction,
        setActive: setWatchlistActivePreviewAction,
      }}
    />
  )
}
