import { getIngestionHealth, summarizeIngestionHealth } from '@mini-crux/db'
import { listWatchlists } from '@mini-crux/db/dashboard'

import { withWorkspace } from '../../../server/db.ts'
import { WatchlistsView } from '../../../views/listas.tsx'
import {
  createWatchlistAction,
  renameWatchlistAction,
  setWatchlistActiveAction,
} from './actions.ts'

/**
 * The watchlist surface's data, and the three writes it can trigger. Everything it renders
 * lives in {@link WatchlistsView} — see `specs/UC-10-ux-preview.md` for why the seam is here,
 * and why the actions are handed over rather than imported by the view itself.
 */
export default async function WatchlistsPage(): Promise<React.ReactElement> {
  // One round trip, one transaction, one tenant. `getIngestionHealth` reads the same view
  // the uptime endpoint reads — here through RLS, so an operator sees their own workspace
  // and only theirs.
  const { watchlists, health } = await withWorkspace(async (db) => ({
    watchlists: await listWatchlists(db),
    health: summarizeIngestionHealth(await getIngestionHealth(db)),
  }))

  return (
    <WatchlistsView
      watchlists={watchlists}
      health={health}
      actions={{
        create: createWatchlistAction,
        rename: renameWatchlistAction,
        setActive: setWatchlistActiveAction,
      }}
    />
  )
}
