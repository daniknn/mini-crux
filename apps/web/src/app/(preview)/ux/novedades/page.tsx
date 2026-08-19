import { ChangeFeedView } from '../../../../views/novedades.tsx'
import { CHANGE_FEED, CHANGE_FEED_QUIET } from '../fixtures/change-feed.ts'
import { PANEL_HEALTH, PANEL_HEALTH_EMPTY } from '../fixtures/panel.ts'

/**
 * `/ux/novedades` — the same component the product renders, fed from fixtures.
 *
 * The only thing this file does that `(dashboard)/novedades/page.tsx` does not is pick which
 * invented panel to hand over. Everything visible is `ChangeFeedView`, unchanged and
 * unwrapped, which is what makes a design review here a review of the product
 * (`specs/UC-10-ux-preview.md` §2).
 */
export default async function PreviewChangeFeedPage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>
}): Promise<React.ReactElement> {
  const { caso } = await searchParams

  // No crawls at all: the feed itself is null, not an empty one. "Todavía no hay rastreos"
  // and "esta semana no pasó nada" are different sentences and this is why they can be.
  if (caso === 'sin-rastreos') {
    return <ChangeFeedView health={PANEL_HEALTH_EMPTY} feed={null} basePath="/ux" />
  }

  const feed = caso === 'sin-movimientos' ? CHANGE_FEED_QUIET : CHANGE_FEED
  return <ChangeFeedView health={PANEL_HEALTH} feed={feed} basePath="/ux" />
}
