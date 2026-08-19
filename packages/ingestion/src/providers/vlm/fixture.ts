import type { HookType, TagCreativeInput, Tone, VlmProvider, VlmRawResponse } from './types.ts'
import { ProviderError } from './types.ts'

/**
 * A provider that replays scripted responses, one per call, in order.
 *
 * Mirrors `providers/ad-library/fixture.ts`'s day-by-day replay, but the axis here is calls,
 * not days: `tagCreative` is invoked once per creative, not once per scheduled crawl tick, so
 * there is no calendar to script against — just a queue of "here is what the model said" (or
 * "here is how the call failed") that the semantic-tagging job's tests consume in order. Once
 * the scripted responses run out, the last one repeats, same as the ad-library fixture's last
 * day — a test that only cares about the first N calls does not need to pad the tail.
 */
export interface FixtureResponse {
  raw: VlmRawResponse
  /** Simulates a provider outage or a malformed call for this response. */
  fail?: { message: string; retryable?: boolean }
}

export interface FixtureVlmProvider extends VlmProvider {
  /** Inputs received so far, in order — lets a test assert the right frames/transcript went out. */
  readonly calls: TagCreativeInput[]
}

export function createFixtureProvider(responses: FixtureResponse[]): FixtureVlmProvider {
  const calls: TagCreativeInput[] = []
  let index = 0

  return {
    name: 'fixture',
    calls,

    async tagCreative(input: TagCreativeInput): Promise<VlmRawResponse> {
      calls.push(input)
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1

      if (response === undefined) {
        throw new ProviderError('Fixture VLM provider has no scripted responses', {
          retryable: false,
        })
      }
      if (response.fail !== undefined) {
        throw new ProviderError(response.fail.message, {
          retryable: response.fail.retryable ?? true,
        })
      }

      return response.raw
    },
  }
}

/**
 * A raw VLM payload with sane defaults, so a test only states the field it is exercising —
 * mirrors `fixtureAd`. Shaped like the real provider's *raw* response (design §3: that is
 * what gets stored and what the semantic-tagging job parses), not like the typed columns it
 * eventually becomes.
 */
export function fixtureTagResponse(
  overrides: Partial<{
    has_people_on_screen: boolean | 'unclear'
    hook_type: HookType | 'unclear'
    tone: Tone | 'unclear'
  }> = {},
): VlmRawResponse {
  return {
    has_people_on_screen: true,
    hook_type: 'demo',
    tone: 'informativo',
    ...overrides,
  }
}
