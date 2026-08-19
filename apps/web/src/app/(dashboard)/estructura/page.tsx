import { getPanelHealth, getStructuralProfile, listAdvertisers } from '@mini-crux/db/dashboard'

import { withWorkspace } from '../../../server/db.ts'
import { StructureView } from '../../../views/estructura.tsx'

/**
 * The structural profile's data. Everything it renders lives in {@link StructureView} — see
 * `specs/UC-10-ux-preview.md` for why the seam is here.
 */
export default async function StructurePage({
  searchParams,
}: {
  searchParams: Promise<{ anunciante?: string; incluir?: string }>
}): Promise<React.ReactElement> {
  const params = await searchParams
  // Defaults to the creatives still running: "¿qué está haciendo este competidor *ahora*?"
  // is the question this surface answers, and averaging in everything they retired two
  // months ago answers a different one.
  const activeOnly = params.incluir !== 'todos'

  const { health, advertisers } = await withWorkspace(async (db) => ({
    health: await getPanelHealth(db),
    advertisers: await listAdvertisers(db),
  }))

  const selectedId = params.anunciante ?? advertisers[0]?.id

  const comparison =
    selectedId === undefined
      ? null
      : await withWorkspace((db) =>
          getStructuralProfile(db, { advertiserId: selectedId, activeOnly }),
        )

  return (
    <StructureView
      health={health}
      advertisers={advertisers}
      selectedId={selectedId}
      activeOnly={activeOnly}
      comparison={comparison}
    />
  )
}
