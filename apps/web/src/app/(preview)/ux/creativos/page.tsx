import type { CreativeSummary, GallerySort } from '@mini-crux/db/dashboard'

import { GalleryView, SORTS, type GalleryStatus } from '../../../../views/creativos.tsx'
import { ADVERTISERS, CREATIVES, POSTERS } from '../fixtures/creatives.ts'
import { PANEL_HEALTH } from '../fixtures/panel.ts'

/**
 * `/ux/creativos` — the gallery, over invented creatives.
 *
 * The filters are live. They are links to search params, the view reads those params to light
 * the active chip, and this page actually applies them to the fixture array — a dozen lines of
 * pure array work, no database involved. A preview whose filters visibly did nothing would
 * make the chips unreviewable exactly where they matter: what a selected chip looks like next
 * to an unselected one, and whether the result count moving is legible.
 *
 * `?caso=vacio` is kept even though a filter combination can now produce an empty gallery on
 * its own. The reviewer should be able to reach the empty state by name from the index rather
 * than by guessing which combination happens to return nothing.
 */

type Search = { caso?: string; anunciante?: string; estado?: string; orden?: string }

function parseSort(raw: string | undefined): GallerySort {
  return SORTS.some((s) => s.value === raw) ? (raw as GallerySort) : 'longest'
}

function parseStatus(raw: string | undefined): GalleryStatus {
  return raw === 'running' || raw === 'stopped' ? raw : 'all'
}

/** The same ordering `listCreatives` asks Postgres for, in the same three flavours. */
function sortCreatives(rows: CreativeSummary[], sort: GallerySort): CreativeSummary[] {
  const byDays = (c: CreativeSummary): number => c.daysActive ?? -1
  switch (sort) {
    case 'newest':
      return [...rows].sort((a, b) => b.firstSeenDate.localeCompare(a.firstSeenDate))
    case 'recently-stopped':
      return [...rows]
        .filter((c) => c.stoppedDate !== null)
        .sort((a, b) => (b.stoppedDate ?? '').localeCompare(a.stoppedDate ?? ''))
    case 'longest':
      return [...rows].sort((a, b) => byDays(b) - byDays(a))
  }
}

export default async function PreviewGalleryPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}): Promise<React.ReactElement> {
  const params = await searchParams
  const sort = parseSort(params.orden)
  const status = parseStatus(params.estado)
  const advertiserId = params.anunciante

  const matching =
    params.caso === 'vacio'
      ? []
      : CREATIVES.filter((c) => {
          if (advertiserId !== undefined && c.advertiserId !== advertiserId) return false
          if (status === 'running') return c.isCensored
          if (status === 'stopped') return !c.isCensored
          return true
        })

  return (
    <GalleryView
      health={PANEL_HEALTH}
      advertisers={ADVERTISERS}
      creatives={sortCreatives(matching, sort)}
      posters={POSTERS}
      sort={sort}
      status={status}
      advertiserId={advertiserId}
      basePath="/ux"
    />
  )
}
