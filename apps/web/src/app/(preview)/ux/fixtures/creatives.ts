import type { CreativeDetail, CreativeObservation, CreativeSummary } from '@mini-crux/db/dashboard'

import type { GalleryAdvertiser } from '../../../../views/creativos.tsx'
import { PREVIEW_CREATIVE_ID } from '../catalog.ts'

/**
 * Invented advertisers and creatives.
 *
 * The names are made up on purpose — no real Mexican brand appears here, because a screenshot
 * of this page will outlive the tab it was taken in and nothing on it should be readable as a
 * claim about a company that exists (`specs/UC-10-ux-preview.md` §5).
 *
 * The mix is the point. One creative is censored and truncated, one is stopped with gaps and
 * no measures at all, one never got a start date from Meta and has no poster. Those are the
 * cases where the gallery has to say something careful, and four clean rows would render a
 * gallery that never has to.
 *
 * The dates agree with `PANEL_HEALTH`: the panel spans 2026-06-01 → 2026-08-18, 79 calendar
 * days of which 74 were healthy, so a creative present since the first crawl has 74
 * observations and `hasGaps`. A fixture whose totals do not reconcile is a fixture that
 * teaches a reviewer to ignore the numbers, which is the opposite of what this page is for.
 */

export const ADVERTISERS: GalleryAdvertiser[] = [
  { id: 'adv-1111', name: 'Bodega Aurora', creativeCount: 41, runningCount: 27 },
  { id: 'adv-2222', name: 'Seguros Alcatraz', creativeCount: 23, runningCount: 9 },
  { id: 'adv-3333', name: 'Café Zócalo', creativeCount: 8, runningCount: 3 },
]

/**
 * Empty, and it has to be: signing a poster URL needs a Supabase client, which is exactly the
 * import the preview is not allowed to have. `Poster` renders its own fallback from the
 * advertiser name, so the layout under review is the real one minus the photograph.
 */
export const POSTERS: ReadonlyMap<string, string> = new Map()

/** The five lost crawl days, as offsets from 2026-06-01. Shared so the totals reconcile. */
const LOST_DAYS = [30, 31, 44, 58, 59]

export const CREATIVES: CreativeSummary[] = [
  {
    creativeId: PREVIEW_CREATIVE_ID,
    creativeHash: 'a91f4c7e5b208d3617fe0c94ab5d72e8',
    advertiserId: 'adv-1111',
    advertiserName: 'Bodega Aurora',
    mediaType: 'video',
    adCopy: 'Treinta años surtiendo la despensa de las mismas familias. Esta es la historia.',
    publisherPlatforms: ['facebook', 'instagram'],
    variantCount: 4,
    startedDate: '2026-03-14',
    firstSeenDate: '2026-06-01',
    stoppedDate: null,
    // Still running, so this is a floor: 2026-03-14 → 2026-08-18.
    daysActive: 157,
    isCensored: true,
    observationDays: 74,
    hasGaps: true,
    posterStoragePath: 'posters/adv-1111/a91f4c7e.jpg',
    firstLineTranscript: '¿Se acuerdan de cuando la lista del súper cabía en una servilleta?',
    // Three minutes — a brand film among performance ads, which is why the structure page
    // reports medians and why this creative's rates are measured over a capped span.
    durationS: 184.6,
  },
  {
    creativeId: '7c2b9e40-1a5d-4f83-b6c1-2d90ef47a5b2',
    creativeHash: 'd4e81b02fa7c6539ae10cb47d2b3f065',
    advertiserId: 'adv-2222',
    advertiserName: 'Seguros Alcatraz',
    mediaType: 'video',
    adCopy: 'Tu auto asegurado en 4 minutos, sin llamadas y sin letras chiquitas.',
    publisherPlatforms: ['facebook'],
    variantCount: 1,
    startedDate: '2026-05-02',
    firstSeenDate: '2026-06-01',
    stoppedDate: '2026-08-11',
    daysActive: 101,
    isCensored: false,
    observationDays: 67,
    hasGaps: true,
    posterStoragePath: 'posters/adv-2222/d4e81b02.jpg',
    // Never extracted, so the card falls back to the ad copy.
    firstLineTranscript: null,
    durationS: null,
  },
  {
    creativeId: 'b58d3a17-9e46-4c20-8f71-3a6e5d2c9014',
    creativeHash: 'f70a2d68c3915e4bda87206fc1e35b49',
    advertiserId: 'adv-3333',
    advertiserName: 'Café Zócalo',
    mediaType: 'image',
    adCopy: 'Tueste del día. Grano de Chiapas, molido al momento.',
    publisherPlatforms: ['instagram'],
    variantCount: 2,
    // Meta gave no start date, so our own first sighting is all there is — which is why
    // "descubierto" and "lanzado" are separate sections on Novedades.
    startedDate: null,
    firstSeenDate: '2026-07-22',
    stoppedDate: null,
    daysActive: 28,
    isCensored: true,
    observationDays: 28,
    hasGaps: false,
    posterStoragePath: null,
    firstLineTranscript: null,
    durationS: null,
  },
  {
    creativeId: '2e94f701-6cb3-48ad-95d2-70f1c8e4b6a3',
    creativeHash: '1c9e05baf3d7482e6015ac93df2b7e60',
    advertiserId: 'adv-1111',
    advertiserName: 'Bodega Aurora',
    mediaType: 'video',
    adCopy: 'Regreso a clases: mochilas, útiles y uniformes en un solo carrito.',
    publisherPlatforms: ['facebook', 'instagram', 'messenger'],
    variantCount: 1,
    startedDate: '2026-07-30',
    firstSeenDate: '2026-07-31',
    stoppedDate: null,
    daysActive: 20,
    isCensored: true,
    observationDays: 19,
    hasGaps: false,
    posterStoragePath: 'posters/adv-1111/1c9e05ba.jpg',
    firstLineTranscript: 'La lista de útiles completa, sin ir a tres tiendas.',
    durationS: 31.8,
  },
]

/** Measured, multi-variant, still running, and measured over a capped span. */
export const CREATIVE_DETAIL: CreativeDetail = {
  ...CREATIVES[0]!,
  adArchiveIds: ['1042938471029384', '1042938471029391', '1198374650192837', '1198374650192841'],
  fullTranscript:
    '¿Se acuerdan de cuando la lista del súper cabía en una servilleta? Nosotros sí. ' +
    'Llevamos treinta años surtiendo la despensa de las mismas familias, y en ese tiempo ' +
    'cambió casi todo: los precios, los pasillos, la manera de pedir. Lo que no cambió es ' +
    'de quién es la lista. Bodega Aurora. Lo de siempre, cuesta menos.',
  firstCutTimeS: 1.2,
  cutsPerSecond: 0.71,
  textDensity: 0.34,
  textInFirst2s: true,
  // The ad outran the sampling cap, so every rate above is over the first 60 s and not over
  // its 184.6 s — a different quantity, and the badge that says so is under review here.
  analysisCapS: 60,
  truncated: true,
  skippedFeatures: [],
  featureSchemaVersion: 3,
  observations: buildObservations({ start: '2026-06-01', days: 79, gaps: LOST_DAYS }),
}

/**
 * Stopped, gapped, and never measured — three different kinds of incompleteness at once.
 *
 * The measures are null *with* a `skippedFeatures` entry, which is the "not measurable" null
 * rather than the "measured absent" one (CLAUDE.md: three kinds of null). A reader has to be
 * able to tell those apart on this screen, and this fixture is the one that shows it.
 */
export const CREATIVE_DETAIL_SPARSE: CreativeDetail = {
  ...CREATIVES[1]!,
  adArchiveIds: ['1509384756102938'],
  fullTranscript: null,
  firstCutTimeS: null,
  cutsPerSecond: null,
  textDensity: null,
  textInFirst2s: null,
  analysisCapS: null,
  truncated: false,
  skippedFeatures: [
    'duration_s',
    'first_cut_time_s',
    'cuts_per_second',
    'text_density',
    'text_in_first_2s',
  ],
  featureSchemaVersion: null,
  // Present until 2026-08-11 (offset 71), then seen-and-gone for the last week.
  observations: buildObservations({
    start: '2026-06-01',
    days: 79,
    gaps: LOST_DAYS,
    presentThrough: 71,
  }),
}

/**
 * A run of daily observations.
 *
 * Built rather than typed out because 79 hand-written rows are 79 chances to make the dates
 * disagree with the totals above, and the history strip is exactly the component that would
 * then be reviewed against data no crawl could produce.
 *
 * `gaps` are days with **no row at all** — a failed crawl writes nothing, not even an absence
 * (CLAUDE.md, panel guardrails). Days after `presentThrough` get a row with `isPresent:
 * false`, which is the other fact entirely: we looked, and it was gone.
 */
function buildObservations({
  start,
  days,
  gaps = [],
  presentThrough = days - 1,
}: {
  start: string
  days: number
  gaps?: number[]
  presentThrough?: number
}): CreativeObservation[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const rows: CreativeObservation[] = []
  for (let i = 0; i < days; i += 1) {
    if (gaps.includes(i)) continue
    rows.push({
      runDate: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
      isPresent: i <= presentThrough,
      crawlStatus: 'succeeded',
    })
  }
  return rows
}
