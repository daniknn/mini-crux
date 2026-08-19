/**
 * The provider boundary for VLM tagging (spec UC-8 §2, domain rule 11's reasoning applied to
 * a second provider). Everything downstream of this file — the semantic-tagging job, the
 * parsed `hook_type`/`tone`/`has_people_on_screen` columns — is written against these types
 * and knows nothing about which model answers them. v1 calls OpenAI's vision-capable chat
 * completions; if that trades against cost or quality later, a different implementation
 * swaps in behind this interface and nothing downstream changes.
 *
 * `ProviderError` is reused from `providers/ad-library`, not redefined here. `crawl.ts` and
 * `proxy-validation.ts` already established the precedent: one retryable-error type shared
 * across providers that otherwise have nothing in common, rather than a parallel class per
 * provider directory.
 */
export { ProviderError } from '../ad-library/types.ts'

/**
 * The fixed taxonomies, pinned exactly to migration 0012's CHECK constraints
 * (`creative_semantic_tags_hook_type_known`, `creative_semantic_tags_tone_known`). Kept as a
 * single source here — not restated in the prompt string and again in the parser — because a
 * taxonomy change is a `SEMANTIC_SCHEMA_VERSION` bump (design §5) that must touch the
 * migration, the prompt, and the parser together; a single constant makes it impossible to
 * update one without the other two failing loudly (a CHECK violation, a type error) instead
 * of silently drifting apart.
 */
export const HOOK_TYPES = [
  'testimonial',
  'demo',
  'problem_solution',
  'ugc',
  'offer',
  'other',
] as const
export type HookType = (typeof HOOK_TYPES)[number]

export const TONES = ['humoristico', 'emocional', 'informativo', 'urgente', 'aspiracional', 'other'] as const
export type Tone = (typeof TONES)[number]

export interface TagCreativeInput {
  /**
   * Signed Storage URLs for the sampled frames — hook, midpoint, near-end, in that order for
   * a video; exactly one for a still image (spec Scope, "Out": single-frame best effort only,
   * mirrors the extractor's own image handling in `_run_semantic_frames`).
   */
  readonly frameUrls: readonly string[]
  /**
   * The whisper transcript UC-2 already extracted. Message-level context a still frame
   * cannot carry on its own — design §2's stated reason `tone` is answerable at all.
   */
  readonly transcript: string | null
}

/**
 * The provider's response verbatim — land raw, parse later (design §3, domain rule 2 applied
 * to a model call rather than a crawl payload). Parsing this into `hook_type`/`tone`/
 * `has_people_on_screen` is the semantic-tagging job's responsibility, not the provider's,
 * for the same reason `normalizeAd` is a separate, testable function from
 * `AdLibraryProvider.crawl()`: a parsing bug must be a reprocess against the stored
 * `raw_response` row, not a second VLM call — which costs money here in a way a re-parse of a
 * crawl snapshot never did.
 */
export type VlmRawResponse = unknown

export interface VlmProvider {
  /** Stable identifier recorded on `creative_semantic_tags.vlm_provider`, e.g. `openai`. */
  readonly name: string
  tagCreative(input: TagCreativeInput): Promise<VlmRawResponse>
}
