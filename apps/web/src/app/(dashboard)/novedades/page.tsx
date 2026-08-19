import { getChangeFeed, getPanelHealth } from '@mini-crux/db/dashboard'

import { windowEndingAt } from '../../../lib/dates.ts'
import { withWorkspace } from '../../../server/db.ts'
import { ChangeFeedView, WINDOW_DAYS } from '../../../views/novedades.tsx'

/**
 * The change feed's data. Everything it renders lives in {@link ChangeFeedView}, which knows
 * nothing about the database — see `specs/UC-10-ux-preview.md` for why the seam is here.
 */
export default async function ChangeFeedPage(): Promise<React.ReactElement> {
  const { health, feed } = await withWorkspace(async (db) => {
    const health = await getPanelHealth(db)
    if (health.lastRunDate === null) return { health, feed: null }
    return {
      health,
      feed: await getChangeFeed(db, windowEndingAt(health.lastRunDate, WINDOW_DAYS)),
    }
  })

  return <ChangeFeedView health={health} feed={feed} />
}
