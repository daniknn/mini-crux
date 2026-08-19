import {
  getPanelHealth,
  listAdvertisers,
  listCreatives,
  type GallerySort,
} from '@mini-crux/db/dashboard'

import { withWorkspace } from '../../../server/db.ts'
import { signPosterUrls } from '../../../server/posters.ts'
import { GalleryView, SORTS, type GalleryStatus } from '../../../views/creativos.tsx'

/**
 * The gallery's data. Everything it renders lives in {@link GalleryView} — see
 * `specs/UC-10-ux-preview.md` for why the seam is here.
 */

type Search = { anunciante?: string; estado?: string; orden?: string }

function parseSort(raw: string | undefined): GallerySort {
  return SORTS.some((s) => s.value === raw) ? (raw as GallerySort) : 'longest'
}

function parseStatus(raw: string | undefined): GalleryStatus {
  return raw === 'running' || raw === 'stopped' ? raw : 'all'
}

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}): Promise<React.ReactElement> {
  const params = await searchParams
  const sort = parseSort(params.orden)
  const status = parseStatus(params.estado)
  // Read straight from the query string with no validation beyond the type: an id belonging
  // to another workspace simply matches nothing, because RLS filters the query. There is no
  // ownership check to write here and therefore none to forget.
  const advertiserId = params.anunciante

  const { health, creatives, advertisers } = await withWorkspace(async (db) => ({
    health: await getPanelHealth(db),
    advertisers: await listAdvertisers(db),
    creatives: await listCreatives(db, {
      sort,
      status,
      ...(advertiserId === undefined ? {} : { advertiserId }),
    }),
  }))

  // Signed after the query, in one batch, and only for the rows RLS actually returned.
  // Nothing here reads a path from `searchParams` — the browser never names an object.
  const posters = await signPosterUrls(creatives.map((c) => c.posterStoragePath))

  return (
    <GalleryView
      health={health}
      advertisers={advertisers}
      creatives={creatives}
      posters={posters}
      sort={sort}
      status={status}
      advertiserId={advertiserId}
    />
  )
}
