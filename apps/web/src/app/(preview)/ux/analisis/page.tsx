import { AnalysisView } from '../../../../views/analisis.tsx'
import { ANALYSIS, ANALYSIS_REFUSED } from '../fixtures/analysis.ts'

/**
 * `/ux/analisis` — the contrast, published and refused.
 *
 * Three states and no controls: this surface has none. What is under review is whether the
 * caveats stay attached to the numbers they qualify, and whether a refusal reads as a
 * countdown rather than as an outage.
 */
export default async function PreviewAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>
}): Promise<React.ReactElement> {
  const { caso } = await searchParams

  if (caso === 'sin-corrida') return <AnalysisView analysis={null} />
  return <AnalysisView analysis={caso === 'rechazado' ? ANALYSIS_REFUSED : ANALYSIS} />
}
