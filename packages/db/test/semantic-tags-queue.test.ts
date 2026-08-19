import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { asAuthenticated, createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The semantic-tagging backlog from migration 0012, plus the tenant isolation on the table
 * it fills: `app.enqueue_pending_semantic_tags`, `app.mark_semantic_tags_stale`, and
 * `creative_semantic_tags` RLS.
 *
 * Same reasoning as `extraction-queue.test.ts` for the UC-2 equivalents of these two
 * functions, one layer up: every failure mode here is silent and costs money in a way the
 * UC-2 reconciler does not. An enqueue that fires ahead of the frames it needs sends the VLM
 * a creative it cannot answer about; one that never fires leaves a creative permanently
 * untagged with nothing reporting it; a version bump that forgets to mark the old row stale
 * lets a superseded taxonomy answer present as current. None of that raises an error.
 */

describe('semantic-tag backlog and RLS', () => {
  let db: TestDb
  let workspaceId: string
  let advertiserId: string

  beforeAll(async () => {
    db = await createTestDb()
    const seeded = await seedWorkspace(db, {
      slug: 'semantic-co',
      name: 'Semantic Co',
      clerkOrgId: 'org_semantic',
      clerkUserId: 'user_semantic',
    })
    workspaceId = seeded.workspaceId

    const [advertiser] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, 'page_1', 'Anunciante') returning id`,
      [workspaceId],
    )
    advertiserId = advertiser!.id
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    // Same reasoning as extraction-queue.test.ts: these functions count over whole-table
    // state, so leakage between tests would change the numbers under assertion, not just
    // leave the database untidy.
    await db.exec('delete from public.creative_semantic_tags')
    await db.exec('delete from public.jobs')
    await db.exec('delete from public.creative_features')
    await db.exec('delete from public.creatives')
  })

  async function seedCreative(hash: string): Promise<string> {
    const [creative] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, media_url)
       values ($1, $2, $3, 'video', 'https://cdn.test/v.mp4?sig=abc') returning id`,
      [workspaceId, advertiserId, hash],
    )
    return creative!.id
  }

  /** A `creative_features` row at the given schema version — current unless told otherwise. */
  async function insertFeatures(
    creativeId: string,
    version: number,
    options: { frames?: string[] | null; stale?: boolean } = {},
  ): Promise<void> {
    const frames = options.frames === undefined ? ['hook.jpg', 'mid.jpg', 'end.jpg'] : options.frames
    await db.query(
      `insert into public.creative_features
         (workspace_id, creative_id, schema_version, semantic_frame_paths, is_stale)
       values ($1, $2, $3, $4, $5)`,
      [workspaceId, creativeId, version, frames, options.stale ?? false],
    )
  }

  async function insertTag(creativeId: string, version: number, ws: string = workspaceId): Promise<void> {
    await db.query(
      `insert into public.creative_semantic_tags (workspace_id, creative_id, schema_version)
       values ($1, $2, $3)`,
      [ws, creativeId, version],
    )
  }

  async function enqueue(version = 1, limit?: number): Promise<number> {
    const [row] = await db.query<{ n: number }>(
      limit === undefined
        ? 'select app.enqueue_pending_semantic_tags($1::integer) as n'
        : 'select app.enqueue_pending_semantic_tags($1::integer, $2::integer) as n',
      limit === undefined ? [version] : [version, limit],
    )
    return Number(row!.n)
  }

  async function markStale(version: number): Promise<number> {
    const [row] = await db.query<{ n: number }>(
      'select app.mark_semantic_tags_stale($1::integer) as n',
      [version],
    )
    return Number(row!.n)
  }

  async function tagJobRows(): Promise<{ status: string; payload: Record<string, unknown> }[]> {
    return db.query(
      `select status, payload from public.jobs where type = 'semantic_tag' order by created_at`,
    )
  }

  describe('app.enqueue_pending_semantic_tags', () => {
    it('enqueues one semantic_tag job per creative with current frames and no tag row', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      await insertFeatures(a, 1)
      await insertFeatures(b, 1)

      expect(await enqueue(1)).toBe(2)

      const jobs = await tagJobRows()
      expect(jobs).toHaveLength(2)
      expect(jobs.every((j) => j.status === 'pending')).toBe(true)
      expect(jobs.every((j) => j.payload['schema_version'] === 1)).toBe(true)
    })

    it('skips a creative whose creative_features row is stale', async () => {
      // AC1/AC5's other half: a stale extraction (superseded by a newer decode pass) must
      // not feed the VLM frames the panel no longer considers current.
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1, { stale: true })

      expect(await enqueue(1)).toBe(0)
    })

    it('skips a creative whose extractor could not decode it (null frames)', async () => {
      // The undecodable-video branch: semantic_frame_paths is null with a skipped_features
      // entry (Python-side, exercised in apps/extractor/tests). Tagging cannot run ahead of
      // frames that were never produced, so the creative is never enqueued — not retried
      // forever against a job that can only fail.
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1, { frames: null })

      expect(await enqueue(1)).toBe(0)
    })

    it('skips a creative already tagged at the target version', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)
      await insertTag(a, 1)

      // Cost discipline (rule 4), enforced by the reconciler itself rather than only by the
      // job: a creative already answered for at the current version is never resent.
      expect(await enqueue(1)).toBe(0)
    })

    it('does not stack a duplicate job while one is already pending or running', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)

      expect(await enqueue(1)).toBe(1)
      // A second tick before the first job finishes must not double the spend.
      expect(await enqueue(1)).toBe(0)
      expect(await tagJobRows()).toHaveLength(1)
    })

    it('honors the batch limit so one tick cannot flood the queue', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      const c = await seedCreative('tuple:c')
      await insertFeatures(a, 1)
      await insertFeatures(b, 1)
      await insertFeatures(c, 1)

      expect(await enqueue(1, 2)).toBe(2)
      // The remainder is not lost — the next tick picks it up.
      expect(await enqueue(1, 2)).toBe(1)
    })

    it('stamps a message id, trace id and a schedule actor on every job it creates', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)
      await enqueue(1)

      const [job] = await db.query<{
        message_id: string
        trace_id: string
        actor: { type: string; id: string }
      }>(`select message_id, trace_id, actor from public.jobs where type = 'semantic_tag'`)

      expect(job!.message_id).toMatch(/^msg_/)
      expect(job!.trace_id).toMatch(/^trc_/)
      expect(job!.actor).toMatchObject({ type: 'schedule', id: 'semantic-tag-reconciler' })
    })
  })

  describe('app.mark_semantic_tags_stale', () => {
    it('marks rows below the target version and returns how many', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      await insertTag(a, 1)
      await insertTag(b, 1)

      expect(await markStale(2)).toBe(2)

      const rows = await db.query<{ is_stale: boolean }>(
        'select is_stale from public.creative_semantic_tags',
      )
      expect(rows.every((r) => r.is_stale)).toBe(true)
    })

    it('leaves rows at or above the target version current', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      await insertTag(a, 1)
      await insertTag(b, 2)

      expect(await markStale(2)).toBe(1)

      const [current] = await db.query<{ is_stale: boolean }>(
        'select is_stale from public.creative_semantic_tags where creative_id = $1',
        [b],
      )
      expect(current!.is_stale).toBe(false)
    })

    it('is idempotent — a repeated bump marks nothing new', async () => {
      const a = await seedCreative('tuple:a')
      await insertTag(a, 1)

      expect(await markStale(2)).toBe(1)
      // Not just tidiness: this is the number an operator reads back after running it twice
      // by mistake, and a count that grows on re-run would misreport the size of the bump.
      expect(await markStale(2)).toBe(0)
    })

    it('keeps the superseded row readable rather than deleting it', async () => {
      const a = await seedCreative('tuple:a')
      await insertTag(a, 1)
      await markStale(2)
      await insertTag(a, 2)

      const rows = await db.query<{ schema_version: number; is_stale: boolean }>(
        'select schema_version, is_stale from public.creative_semantic_tags order by schema_version',
      )
      // Both versions coexist — a taxonomy change is auditable, not just applied.
      expect(rows).toEqual([
        { schema_version: 1, is_stale: true },
        { schema_version: 2, is_stale: false },
      ])
    })

    it('does not enqueue anything by itself', async () => {
      const a = await seedCreative('tuple:a')
      await insertTag(a, 1)
      await markStale(2)

      // The split is deliberate (same as mark_features_stale, 0004): staleness is recorded
      // even if the worker is down or the re-tag never runs, so a superseded answer cannot
      // silently keep presenting as current.
      expect(await tagJobRows()).toHaveLength(0)
    })
  })

  describe('the full re-tag path (AC5): bump, then reconcile', () => {
    it('marks the old row stale and the reconciler enqueues its replacement', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)
      await insertTag(a, 1)

      // Before the bump: current at v1, nothing to enqueue.
      expect(await enqueue(1)).toBe(0)

      const marked = await markStale(2)
      expect(marked).toBe(1)

      const [stale] = await db.query<{ is_stale: boolean }>(
        'select is_stale from public.creative_semantic_tags where creative_id = $1 and schema_version = 1',
        [a],
      )
      expect(stale!.is_stale).toBe(true)

      // After the bump: v1 is stale, no v2 row exists yet — the reconciler picks it up.
      expect(await enqueue(2)).toBe(1)
      const jobs = await tagJobRows()
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.payload).toMatchObject({ creative_id: a, schema_version: 2 })
    })
  })

  describe('tenant isolation', () => {
    it('shows a workspace only its own semantic tags', async () => {
      const other = await seedWorkspace(db, {
        slug: 'semantic-other',
        name: 'Other Co',
        clerkOrgId: 'org_semantic_other',
        clerkUserId: 'user_semantic_other',
      })
      const [otherAdvertiser] = await db.query<{ id: string }>(
        `insert into public.advertisers (workspace_id, meta_page_id, name)
         values ($1, 'page_1', 'Otro') returning id`,
        [other.workspaceId],
      )

      const mine = await seedCreative('tuple:mine')
      await insertTag(mine, 1)

      const [theirCreative] = await db.query<{ id: string }>(
        `insert into public.creatives
           (workspace_id, advertiser_id, creative_hash, media_type, media_url)
         values ($1, $2, 'tuple:theirs', 'video', 'https://cdn.test/o.mp4?sig=x') returning id`,
        [other.workspaceId, otherAdvertiser!.id],
      )
      await insertTag(theirCreative!.id, 1, other.workspaceId)

      // PGlite's default connection is a superuser and bypasses RLS unconditionally — the
      // assertion has to run as `authenticated` or it passes while proving nothing.
      const visibleToMine = await asAuthenticated(
        db,
        { sub: 'user_semantic', org_id: 'org_semantic' },
        (d) => d.query<{ creative_id: string }>('select creative_id from public.creative_semantic_tags'),
      )
      expect(visibleToMine.map((r) => r.creative_id)).toEqual([mine])

      const visibleToOther = await asAuthenticated(
        db,
        { sub: 'user_semantic_other', org_id: 'org_semantic_other' },
        (d) => d.query<{ creative_id: string }>('select creative_id from public.creative_semantic_tags'),
      )
      expect(visibleToOther.map((r) => r.creative_id)).toEqual([theirCreative!.id])
    })

    it('grants no insert, update or delete to the authenticated role', async () => {
      // creative_semantic_tags is written only by the job worker, which connects on
      // SUPABASE_DB_URL and bypasses RLS entirely — the same posture as creative_features
      // (0004). `authenticated` gets read-only access; a grant here would let a browser
      // client write a tag directly, skipping the VLM call and the raw_response it produces.
      const a = await seedCreative('tuple:a')

      await expect(
        asAuthenticated(db, { sub: 'user_semantic', org_id: 'org_semantic' }, (d) =>
          d.query(
            `insert into public.creative_semantic_tags (workspace_id, creative_id, schema_version)
             values ($1, $2, 1)`,
            [workspaceId, a],
          ),
        ),
      ).rejects.toThrow(/permission denied/i)
    })
  })
})
