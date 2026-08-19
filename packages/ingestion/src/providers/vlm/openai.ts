import type { TagCreativeInput, VlmProvider, VlmRawResponse } from './types.ts'
import { HOOK_TYPES, ProviderError, TONES } from './types.ts'

/**
 * OpenAI-backed VLM provider (v1).
 *
 * The model is addressed by name from configuration rather than hardcoded — same reasoning
 * as `ApifyProviderConfig.actorId`: swapping the model, or the vendor entirely, must be a
 * config change, not a rewrite (design §2, domain rule 11). Any vision-capable chat
 * completions model works; nothing here is tied to a specific one.
 *
 * The prompt asks for exactly the three tags migration 0012's CHECK constraints allow, plus
 * an explicit `"unclear"` escape hatch on every field — design §4's three-kinds-of-null
 * applied to a model call. A forced-choice prompt with no escape hatch invites the model to
 * guess rather than decline, which is exactly the failure mode that would collapse "the model
 * doesn't know" into "the model said no" and move creatives between cohorts silently.
 */

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

/** Three still frames plus a short transcript; slower than a text-only call but not by much. */
const DEFAULT_TIMEOUT_MS = 60 * 1000

export interface OpenAiVlmProviderConfig {
  apiKey: string
  /** e.g. `gpt-4o-mini`. Must be a vision-capable chat completions model. */
  model: string
  timeoutMs?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function createOpenAiVlmProvider(config: OpenAiVlmProviderConfig): VlmProvider {
  const doFetch = config.fetchImpl ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: 'openai',

    async tagCreative(input: TagCreativeInput): Promise<VlmRawResponse> {
      if (input.frameUrls.length === 0) {
        // A decode failure already left semantic_frame_paths null and skipped the feature
        // upstream (UC-2 rule 1); the reconciler's gate on that column existing means this
        // job should never have been enqueued for such a creative. Reaching here with no
        // frames is a caller bug, not a model failure a retry could fix.
        throw new ProviderError('tagCreative called with no frame URLs', { retryable: false })
      }

      const timeout = AbortSignal.timeout(timeoutMs)

      let response: Response
      try {
        response = await doFetch(OPENAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Header, not a query param: query strings end up in proxy and CDN logs.
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(buildRequestBody(config.model, input)),
          signal: timeout,
        })
      } catch (error) {
        throw new ProviderError('OpenAI request failed', { retryable: true, cause: error })
      }

      if (!response.ok) {
        // 4xx other than 429 means our request is wrong; retrying it wastes the retry budget
        // (and money) on a call that cannot succeed.
        const retryable = response.status === 429 || response.status >= 500
        throw new ProviderError(`OpenAI returned ${response.status}`, { retryable })
      }

      // The full response body, verbatim — land raw, parse later (design §3). The
      // semantic-tagging job pulls `choices[0].message.content` back out and JSON.parses it;
      // that split is deliberate, same reason `normalizeAd` is split from `crawl()`: a
      // parsing bug is then a reprocess against the stored `raw_response` row, not a second,
      // paid call.
      return (await response.json()) as VlmRawResponse
    },
  }
}

function buildRequestBody(model: string, input: TagCreativeInput): Record<string, unknown> {
  const imageContent = input.frameUrls.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }))

  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text:
              input.transcript === null
                ? 'Transcript: (none — no speech detected).'
                : `Transcript: ${input.transcript}`,
          },
          ...imageContent,
        ],
      },
    ],
  }
}

const SYSTEM_PROMPT = `You are tagging a video ad's creative content from sampled frames \
(hook, midpoint, near-end, in that order — a single frame if this is a still image) and its \
transcript. Answer with a single JSON object with exactly these three keys, no others:

- "has_people_on_screen": true, false, or "unclear" if the frames do not make it clear.
- "hook_type": one of ${HOOK_TYPES.map((t) => `"${t}"`).join(', ')}, or "unclear" if none of \
those fit or the frames do not give you enough to decide.
- "tone": one of ${TONES.map((t) => `"${t}"`).join(', ')}, or "unclear" if you cannot tell.

Do not guess. "unclear" is a correct, expected answer when the evidence does not support a \
real one — it is not a failure to avoid.`
