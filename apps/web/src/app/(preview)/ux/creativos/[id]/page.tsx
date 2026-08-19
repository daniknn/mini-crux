import { CreativeDetailView } from '../../../../../views/creativo-detalle.tsx'
import { CREATIVE_DETAIL, CREATIVE_DETAIL_SPARSE } from '../../fixtures/creatives.ts'

/**
 * `/ux/creativos/[id]` — one creative, in detail.
 *
 * The id in the URL is ignored on purpose. There are two fixtures and no lookup table, so any
 * card in the gallery lands here and renders something rather than a 404 — a dead link in the
 * middle of a design review costs a reviewer more than a technically-correct one would buy.
 * The product's own route does the opposite and should: it validates the uuid and calls
 * `notFound()` (`(dashboard)/creativos/[id]/page.tsx`).
 *
 * `posterUrl` is always null. Signing one needs a Supabase client, which is the import this
 * tree is not allowed to have, so `Poster` renders its text fallback — which is itself worth
 * reviewing, since it is what every creative shows until the extractor catches up.
 */
export default async function PreviewCreativeDetailPage({
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ caso?: string }>
}): Promise<React.ReactElement> {
  const { caso } = await searchParams
  const creative = caso === 'escaso' ? CREATIVE_DETAIL_SPARSE : CREATIVE_DETAIL

  return <CreativeDetailView creative={creative} posterUrl={null} />
}
