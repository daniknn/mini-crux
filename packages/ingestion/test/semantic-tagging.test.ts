import { newTraceId, operatorActor } from '@mini-crux/core'
import type { TestDb } from '@mini-crux/db/testing'
import { createTestDb, seedWorkspace } from '@mini-crux/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFixtureMediaUrlSigner } from '../src/media-urls.ts'
import { createFixtureProvider, fixtureTagResponse } from '../src/providers/vlm/fixture.ts'
import type { FixtureVlmProvider } from '../src/providers/vlm/fixture.ts'
import { ProviderError } from '../src/providers/vlm/types.ts'
import {
  runSemanticTag,
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_TAG_JOB_TYPE,
} from '../src/semantic-tagging.ts'

/**
 * UC-8's job, exercised against the real migrated schema — the CHECK constraints on
 * `hook_type`/`tone` (migration 0012) and the `unique (creative_id, schema_version)` race
 * guard are exactly the kind of thing a mocked `SqlExecutor` cannot catch a drift against.
 */

const FRAME_PATHS = ['media/hook.jpg', 'media/mid.jpg', 'media/end.jpg']
const SIGNED_URLS = {
  'media/hook.jpg': 'https://cdn.test/hook.jpg?sig=1',
  'media/mid.jpg': 'https://cdn.test/mid.jpg?sig=1',
  'media/end.jpg': 'https://cdn.test/end.jpg?sig=1',
}

let db: TestDb
let workspaceId: string
let advertiserId: string

beforeEach(async () => {
  db = await createTestDb()
  const seeded = await seedWorkspace(db, {
    slug: 'tag-co',
    name: 'Tag Co',
    clerkOrgId: 'org_tag',
    clerkUserId: 'user_tag',
  })
  workspaceId = seeded.workspaceId

  const [advertiser] = await db.query<{ id: string }>(
    `insert into public.advertisers (workspace_id, meta_page_id, name)
     values ($1, 'page_1', 'Anunciante') returning id`,
    [workspaceId],
  )
  advertiserId = advertiser!.id
})

afterEach(async () => {
  await db.close()
})

async function seedCreative(hash: string): Promise<string> {
  const [creative] = await db.query<{ id: string }>(
    `insert into public.creatives (workspace_id, advertiser_id, creative_hash, media_type, media_url)
     values ($1, $2, $3, 'video', 'https://cdn.test/v.mp4?sig=abc') returning id`,
    [workspaceId, advertiserId, hash],
  )
  return creative!.id
}

async function insertFeatures(
  creativeId: string,
  options: {
    schemaVersion?: number
    framePaths?: string[] | null
    transcript?: string | null
    isStale?: boolean
  } = {},
): Promise<void> {
  await db.query(
    `insert into public.creative_features
       (workspace_id, creative_id, schema_version, semantic_frame_paths, full_transcript, is_stale)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      workspaceId,
      creativeId,
      options.schemaVersion ?? 1,
      options.framePaths === undefined ? FRAME_PATHS : options.framePaths,
      options.transcript ?? 'Compra ahora',
      options.isStale ?? false,
    ],
  )
}

async function tagRow(creativeId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.query(
    `select has_people_on_screen, hook_type, tone, skipped_tags, raw_response, vlm_provider,
            vlm_model, trace_id, is_stale
     from public.creative_semantic_tags
     where creative_id = $1 and schema_version = $2`,
    [creativeId, SEMANTIC_SCHEMA_VERSION],
  )
  return rows[0]
}

function input(creativeId: string, overrides: { schemaVersion?: number } = {}) {
  return {
    workspaceId,
    traceId: newTraceId(),
    actor: operatorActor('user_tag', 'test'),
    creativeId,
    ...overrides,
  }
}

describe('runSemanticTag', () => {
  it('is the job type app.enqueue_pending_semantic_tags dispatches', () => {
    expect(SEMANTIC_TAG_JOB_TYPE).toBe('semantic_tag')
  })

  it('signs the frame paths, calls the provider, and stores every field it answered', async () => {
    const creativeId = await seedCreative('tag:a')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([
      { raw: fixtureTagResponse({ hook_type: 'testimonial', tone: 'urgente' }) },
    ])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const outcome = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))

    expect(outcome).toMatchObject({ status: 'tagged', skippedTags: [] })
    expect(provider.calls).toEqual([
      { frameUrls: Object.values(SIGNED_URLS), transcript: 'Compra ahora' },
    ])

    const row = await tagRow(creativeId)
    expect(row).toMatchObject({
      has_people_on_screen: true,
      hook_type: 'testimonial',
      tone: 'urgente',
      skipped_tags: [],
      vlm_provider: 'fixture',
      is_stale: false,
    })
    expect(row!['raw_response']).toMatchObject({ hook_type: 'testimonial', tone: 'urgente' })
  })

  it('appends an audit event on the trace it was given', async () => {
    const creativeId = await seedCreative('tag:audit')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)
    const traceId = newTraceId()

    const outcome = await runSemanticTag(
      { db, provider, mediaUrlSigner },
      { workspaceId, traceId, actor: operatorActor('user_tag'), creativeId },
    )
    expect(outcome.status).toBe('tagged')

    const events = await db.query<{ type: string; trace_id: string; payload: Record<string, unknown> }>(
      'select type, trace_id, payload from public.audit_events where trace_id = $1',
      [traceId],
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'creative.semantic_tagged', trace_id: traceId })
    expect(events[0]!.payload).toMatchObject({ vlm_provider: 'fixture', skipped_tags: [] })
  })

  it('never calls the provider a second time for the same (creative, schema_version)', async () => {
    const creativeId = await seedCreative('tag:once')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }]) as FixtureVlmProvider
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const first = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))
    const second = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))

    expect(first.status).toBe('tagged')
    expect(second).toMatchObject({ status: 'already-tagged' })
    if (first.status === 'tagged' && second.status === 'already-tagged') {
      expect(second.tagId).toBe(first.tagId)
    }
    // The whole point of the precheck: a redelivery must not bill a second VLM call.
    expect(provider.calls).toHaveLength(1)
  })

  it('degrades every field the model declined, without failing the job', async () => {
    const creativeId = await seedCreative('tag:unclear')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([
      { raw: fixtureTagResponse({ has_people_on_screen: 'unclear', hook_type: 'unclear' }) },
    ])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const outcome = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))

    expect(outcome).toMatchObject({
      status: 'tagged',
      skippedTags: ['has_people_on_screen', 'hook_type'],
    })
    const row = await tagRow(creativeId)
    expect(row).toMatchObject({
      has_people_on_screen: null,
      hook_type: null,
      tone: 'informativo',
      skipped_tags: ['has_people_on_screen', 'hook_type'],
    })
  })

  it('skips all three fields on a raw response it cannot parse at all, never a thrown error', async () => {
    const creativeId = await seedCreative('tag:garbage')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: { choices: [] } }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const outcome = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))

    expect(outcome).toMatchObject({
      status: 'tagged',
      skippedTags: ['has_people_on_screen', 'hook_type', 'tone'],
    })
    const row = await tagRow(creativeId)
    expect(row).toMatchObject({ has_people_on_screen: null, hook_type: null, tone: null })
  })

  it('refuses a creative with no current, non-stale features row', async () => {
    const creativeId = await seedCreative('tag:no-features')
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    await expect(runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))).rejects.toThrow(
      /no current creative_features row/,
    )
    expect(provider.calls).toHaveLength(0)
  })

  it('ignores a stale features row — cannot tag ahead of frames that were superseded', async () => {
    const creativeId = await seedCreative('tag:stale')
    await insertFeatures(creativeId, { isStale: true })
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    await expect(
      runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId)),
    ).rejects.toThrow(/no current creative_features row/)
  })

  it('refuses a creative whose features row has no frame paths', async () => {
    const creativeId = await seedCreative('tag:no-frames')
    await insertFeatures(creativeId, { framePaths: null })
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    await expect(runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))).rejects.toThrow(
      /no current creative_features row/,
    )
    expect(provider.calls).toHaveLength(0)
  })

  it('treats a Storage signing failure as retryable, distinct from a caller-bug empty-frames refusal', async () => {
    const creativeId = await seedCreative('tag:sign-fail')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    // No paths in the map — every sign() call comes back empty, as it would if Storage were down.
    const mediaUrlSigner = createFixtureMediaUrlSigner({})

    await expect(runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))).rejects.toThrow(
      /could be signed/,
    )
    // The provider was never billed for a call that could not have produced a usable answer.
    expect(provider.calls).toHaveLength(0)
  })

  it('drops individual frames that failed to sign but still tags on the rest', async () => {
    const creativeId = await seedCreative('tag:partial-sign')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner({ 'media/hook.jpg': SIGNED_URLS['media/hook.jpg'] })

    const outcome = await runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))

    expect(outcome.status).toBe('tagged')
    expect(provider.calls).toEqual([
      { frameUrls: [SIGNED_URLS['media/hook.jpg']], transcript: 'Compra ahora' },
    ])
  })

  it('wraps a provider failure in a plain Error, not the raw ProviderError', async () => {
    const creativeId = await seedCreative('tag:provider-fail')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: null, fail: { message: 'quota exceeded' } }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const promise = runSemanticTag({ db, provider, mediaUrlSigner }, input(creativeId))
    await expect(promise).rejects.toThrow(/quota exceeded/)
    await expect(promise).rejects.not.toBeInstanceOf(ProviderError)
  })

  it('pays for the VLM call but loses a race to another worker gracefully', async () => {
    const creativeId = await seedCreative('tag:race')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])

    // A signer that plants a competing row the instant it is asked to sign — simulating a
    // second worker finishing the same creative between this call's precheck and its insert.
    let racedTagId: string | null = null
    const racingSigner = {
      async sign(paths: readonly string[]): Promise<Map<string, string>> {
        const [row] = await db.query<{ id: string }>(
          `insert into public.creative_semantic_tags (workspace_id, creative_id, schema_version, vlm_provider)
           values ($1, $2, $3, 'other-worker') returning id`,
          [workspaceId, creativeId, SEMANTIC_SCHEMA_VERSION],
        )
        racedTagId = row!.id
        const signed = new Map<string, string>()
        for (const path of paths) signed.set(path, SIGNED_URLS[path as keyof typeof SIGNED_URLS]!)
        return signed
      },
    }

    const outcome = await runSemanticTag({ db, provider, mediaUrlSigner: racingSigner }, input(creativeId))

    // The call still happened — cost discipline cannot protect against a genuine race, only
    // against a redelivery, which is exactly what the module doc comment says.
    expect(provider.calls).toHaveLength(1)
    expect(outcome).toMatchObject({ status: 'already-tagged', tagId: racedTagId })
  })

  it('respects an explicit schemaVersion instead of the module default', async () => {
    const creativeId = await seedCreative('tag:version')
    await insertFeatures(creativeId)
    const provider = createFixtureProvider([{ raw: fixtureTagResponse() }])
    const mediaUrlSigner = createFixtureMediaUrlSigner(SIGNED_URLS)

    const outcome = await runSemanticTag(
      { db, provider, mediaUrlSigner },
      input(creativeId, { schemaVersion: 7 }),
    )
    expect(outcome.status).toBe('tagged')

    const rows = await db.query<{ schema_version: number }>(
      'select schema_version from public.creative_semantic_tags where creative_id = $1',
      [creativeId],
    )
    expect(rows).toEqual([{ schema_version: 7 }])
  })
})
