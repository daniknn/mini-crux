import { createHash } from 'node:crypto'

import type { AdLibraryAd } from './providers/ad-library/index.ts'

/**
 * Creative identity — the dedup key for the unit of analysis (CLAUDE.md rule 4).
 *
 * One creative is reused across many `ad_archive_id`s. Treating the ad as the unit would
 * count the same asset once per archive id, inflating whatever it is later correlated
 * against and making a single heavily-collated creative look like a trend.
 *
 * Two tiers, in strict precedence order:
 *
 * 1. **Media bytes (SHA-256).** Exact and provider-independent. Not available during
 *    ingestion — nothing is downloaded until UC-2 — so this path exists for the parse
 *    reprocess that runs after extraction has fetched the file.
 * 2. **`(advertiser, normalized copy, media type)`.** The fallback that actually runs at
 *    ingestion time. Deliberately NOT keyed on `media_url`: Ad Library media URLs are
 *    signed and rotate between crawls, so hashing one would mint a brand-new creative
 *    every single day and turn every ad into a one-day life. That failure mode would be
 *    invisible in the data and catastrophic for the survival estimate.
 *
 * Perceptual hashing over sampled frames is the documented upgrade for re-encoded
 * duplicates that break byte equality (ARCHITECTURE.md §6).
 */

export type CreativeHashBasis = 'media-sha256' | 'advertiser-copy-media'

export interface CreativeIdentity {
  hash: string
  basis: CreativeHashBasis
}

export function creativeIdentityFromMedia(mediaSha256: string): CreativeIdentity {
  return { hash: `sha256:${mediaSha256}`, basis: 'media-sha256' }
}

export function creativeIdentityFromAd(
  ad: Pick<AdLibraryAd, 'adCopy' | 'mediaType'>,
  advertiserId: string,
): CreativeIdentity {
  const digest = createHash('sha256')
    .update(
      // Unit separator between fields so ("ab", "c") and ("a", "bc") cannot collide.
      [advertiserId, normalizeCopy(ad.adCopy), ad.mediaType].join(''),
      'utf8',
    )
    .digest('hex')

  return { hash: `tuple:${digest}`, basis: 'advertiser-copy-media' }
}

/**
 * Normalize ad copy for comparison only — the original is stored untouched on the creative.
 *
 * Unicode NFKC first so a typographic apostrophe and an ASCII one, or a full-width digit
 * and a normal one, do not fork a creative in two. Meta re-renders copy between crawls
 * often enough that this matters in practice.
 */
export function normalizeCopy(copy: string | null): string {
  if (copy === null) return ''
  return copy
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}
