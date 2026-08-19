import { StructureView } from '../../../../views/estructura.tsx'
import { ADVERTISERS } from '../fixtures/creatives.ts'
import { PANEL_HEALTH, PANEL_HEALTH_EMPTY } from '../fixtures/panel.ts'
import { COMPARISON, COMPARISON_THIN } from '../fixtures/structure.ts'

/**
 * `/ux/estructura` — one advertiser's build against the panel's.
 *
 * The advertiser chips are live in the same limited sense as the gallery's: they change the
 * URL and the selected chip follows, and the third advertiser gets the thin profile so a
 * reviewer can see the small-sample warning without editing a query string. The first two
 * share the full comparison, because which invented advertiser owns which invented median is
 * not something a design review has an opinion about.
 */
export default async function PreviewStructurePage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string; anunciante?: string; incluir?: string }>
}): Promise<React.ReactElement> {
  const params = await searchParams

  // No advertisers at all. `comparison` is null exactly when `selectedId` is undefined — the
  // pairing the view treats as "panel still empty" rather than as an error.
  if (params.caso === 'vacio') {
    return (
      <StructureView
        health={PANEL_HEALTH_EMPTY}
        advertisers={[]}
        selectedId={undefined}
        activeOnly
        comparison={null}
        basePath="/ux"
      />
    )
  }

  const selectedId = params.anunciante ?? ADVERTISERS[0]!.id
  const thin = params.caso === 'un-anunciante' || selectedId === ADVERTISERS[2]!.id

  return (
    <StructureView
      health={PANEL_HEALTH}
      advertisers={ADVERTISERS}
      selectedId={thin ? ADVERTISERS[2]!.id : selectedId}
      activeOnly={params.incluir !== 'todos'}
      comparison={thin ? COMPARISON_THIN : COMPARISON}
      basePath="/ux"
    />
  )
}
