import { describe, expect, it, vi } from 'vitest'

import {
  createFixtureProvider,
  fixtureTagResponse,
} from '../src/providers/vlm/fixture.ts'
import { createOpenAiVlmProvider } from '../src/providers/vlm/openai.ts'
import { ProviderError } from '../src/providers/vlm/types.ts'

/**
 * Scoped like `apify.test.ts`: the fixture provider's scripted-replay contract (what the
 * semantic-tagging job's own tests will depend on), and the real provider's request shape and
 * error handling — the parts a live-credential smoke test cannot cheaply cover and a wrong
 * message shape would otherwise only surface as a silent all-"unclear" response in staging.
 */

describe('createFixtureProvider (VLM)', () => {
  it('replays scripted responses in order and records the calls', async () => {
    const provider = createFixtureProvider([
      { raw: fixtureTagResponse({ hook_type: 'testimonial' }) },
      { raw: fixtureTagResponse({ hook_type: 'offer' }) },
    ])

    const first = await provider.tagCreative({ frameUrls: ['https://cdn.test/1.jpg'], transcript: 'hola' })
    const second = await provider.tagCreative({ frameUrls: ['https://cdn.test/2.jpg'], transcript: null })

    expect(first).toMatchObject({ hook_type: 'testimonial' })
    expect(second).toMatchObject({ hook_type: 'offer' })
    expect(provider.calls).toEqual([
      { frameUrls: ['https://cdn.test/1.jpg'], transcript: 'hola' },
      { frameUrls: ['https://cdn.test/2.jpg'], transcript: null },
    ])
  })

  it('repeats the last scripted response once the list is exhausted', async () => {
    const provider = createFixtureProvider([{ raw: fixtureTagResponse({ tone: 'urgente' }) }])

    await provider.tagCreative({ frameUrls: ['https://cdn.test/1.jpg'], transcript: null })
    const third = await provider.tagCreative({ frameUrls: ['https://cdn.test/2.jpg'], transcript: null })

    expect(third).toMatchObject({ tone: 'urgente' })
  })

  it('throws a non-retryable ProviderError when scripted with no responses at all', async () => {
    const provider = createFixtureProvider([])
    await expect(provider.tagCreative({ frameUrls: ['x'], transcript: null })).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
    })
  })

  it('throws the scripted failure, retryable unless told otherwise', async () => {
    const provider = createFixtureProvider([
      { raw: null, fail: { message: 'quota exceeded' } },
      { raw: null, fail: { message: 'bad request', retryable: false } },
    ])

    await expect(provider.tagCreative({ frameUrls: ['x'], transcript: null })).rejects.toMatchObject({
      message: 'quota exceeded',
      retryable: true,
    })
    await expect(provider.tagCreative({ frameUrls: ['x'], transcript: null })).rejects.toMatchObject({
      message: 'bad request',
      retryable: false,
    })
  })
})

describe('fixtureTagResponse', () => {
  it('defaults to a fully-answered response', () => {
    expect(fixtureTagResponse()).toEqual({
      has_people_on_screen: true,
      hook_type: 'demo',
      tone: 'informativo',
    })
  })

  it('lets a test state only the field it is exercising', () => {
    expect(fixtureTagResponse({ tone: 'unclear' })).toMatchObject({ tone: 'unclear' })
  })
})

describe('createOpenAiVlmProvider', () => {
  function jsonResponse(body: unknown, init?: { status?: number }): Response {
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('sends the frames as image_url content blocks alongside the transcript', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }))
    const provider = createOpenAiVlmProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    })

    await provider.tagCreative({
      frameUrls: ['https://cdn.test/hook.jpg', 'https://cdn.test/mid.jpg'],
      transcript: 'Compra ahora',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-test' })

    const body = JSON.parse(init.body as string) as {
      model: string
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.model).toBe('gpt-4o-mini')
    const userMessage = body.messages[1] as { content: Array<Record<string, unknown>> }
    expect(userMessage.content[0]).toMatchObject({ type: 'text', text: 'Transcript: Compra ahora' })
    expect(userMessage.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.test/hook.jpg' },
    })
    expect(userMessage.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.test/mid.jpg' },
    })
  })

  it('states a null transcript explicitly rather than sending an empty string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }))
    const provider = createOpenAiVlmProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl })

    await provider.tagCreative({ frameUrls: ['https://cdn.test/1.jpg'], transcript: null })

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: unknown }> }
    const userMessage = body.messages[1] as { content: Array<Record<string, unknown>> }
    expect(userMessage.content[0]).toMatchObject({ text: expect.stringContaining('none') })
  })

  it('returns the response body verbatim — land raw, parse later', async () => {
    const raw = { choices: [{ message: { content: '{"hook_type":"demo"}' } }] }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(raw))
    const provider = createOpenAiVlmProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl })

    const result = await provider.tagCreative({ frameUrls: ['https://cdn.test/1.jpg'], transcript: null })
    expect(result).toEqual(raw)
  })

  it('refuses to call the model with no frames — a caller bug, not a retryable failure', async () => {
    const fetchImpl = vi.fn()
    const provider = createOpenAiVlmProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl })

    await expect(provider.tagCreative({ frameUrls: [], transcript: null })).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('wraps a network failure in a retryable ProviderError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const provider = createOpenAiVlmProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl })

    await expect(
      provider.tagCreative({ frameUrls: ['https://cdn.test/1.jpg'], transcript: null }),
    ).rejects.toMatchObject({ name: 'ProviderError', retryable: true })
  })

  it('treats a 429 as retryable and a 400 as not', async () => {
    const rateLimited = vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 }))
    const badRequest = vi.fn().mockResolvedValue(jsonResponse({}, { status: 400 }))

    await expect(
      createOpenAiVlmProvider({ apiKey: 'k', model: 'm', fetchImpl: rateLimited }).tagCreative({
        frameUrls: ['x'],
        transcript: null,
      }),
    ).rejects.toMatchObject({ retryable: true })

    await expect(
      createOpenAiVlmProvider({ apiKey: 'k', model: 'm', fetchImpl: badRequest }).tagCreative({
        frameUrls: ['x'],
        transcript: null,
      }),
    ).rejects.toMatchObject({ retryable: false })
  })

  it('is the same ProviderError class the ad-library provider raises', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'))
    const provider = createOpenAiVlmProvider({ apiKey: 'k', model: 'm', fetchImpl })

    await expect(
      provider.tagCreative({ frameUrls: ['x'], transcript: null }),
    ).rejects.toBeInstanceOf(ProviderError)
  })
})
