import { getCreativeDetail } from '@mini-crux/db/dashboard'
import { notFound } from 'next/navigation'

import { withWorkspace } from '../../../../server/db.ts'
import { signPosterUrl } from '../../../../server/posters.ts'
import { CreativeDetailView } from '../../../../views/creativo-detalle.tsx'

/**
 * The creative detail's data, its 404s, and its signed poster. Everything it renders lives in
 * {@link CreativeDetailView} — see `specs/UC-10-ux-preview.md` for why the seam is here.
 */
export default async function CreativeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params

  // A malformed id would make Postgres reject the `::uuid` cast, which is a 500 for what is
  // really a 404. Checked here so a typo'd URL reads as "not found".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()

  const creative = await withWorkspace((db) => getCreativeDetail(db, id))
  // Null covers both "no such creative" and "belongs to another workspace" — RLS returns the
  // same empty result for each, and rendering the same 404 is what keeps them
  // indistinguishable to a caller probing for ids.
  if (creative === null) notFound()

  // Signed only after the 404 above. Doing it before would sign a path for a creative the
  // caller is not allowed to know exists.
  const posterUrl = await signPosterUrl(creative.posterStoragePath)

  return <CreativeDetailView creative={creative} posterUrl={posterUrl} />
}
