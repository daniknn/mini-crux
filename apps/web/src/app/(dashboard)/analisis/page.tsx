import { getLatestAnalysis } from '@mini-crux/db/dashboard'

import { withWorkspace } from '../../../server/db.ts'
import { AnalysisView } from '../../../views/analisis.tsx'

/**
 * The analysis surface's data — one read, and nothing computed. Everything it renders lives
 * in {@link AnalysisView}; see `specs/UC-10-ux-preview.md` for why the seam is here.
 */
export default async function AnalysisPage(): Promise<React.ReactElement> {
  const analysis = await withWorkspace((db) => getLatestAnalysis(db))

  return <AnalysisView analysis={analysis} />
}
