import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The extraction backlog and job-liveness functions from migration 0004.
 *
 * These four functions are the only part of UC-2 that decides *what gets measured and
 * when*, and every one of their failure modes is silent. A reconciler that double-enqueues
 * burns a Fly machine on work already done; one that under-enqueues leaves creatives
 * permanently unmeasured with nothing reporting it; a reaper that requeues a healthy job
 * extracts the same creative twice. None of that raises an error — it shows up much later
 * as an unexplained gap in the panel.
 *
 * So they are exercised against the real migrated schema rather than trusted to review.
 */

const CREATIVE_TYPES = "('video', 'image')"

describe('extraction backlog and job liveness', () => {
  let db: TestDb
  let workspaceId: string
  let advertiserId: string

  beforeAll(async () => {
    db = await createTestDb()
    const seeded = await seedWorkspace(db, {
      slug: 'extract-co',
      name: 'Extract Co',
      clerkOrgId: 'org_extract',
      clerkUserId: 'user_extract',
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
    // Every test starts from an empty queue and an empty panel. The functions under test
    // are counters over whole-table state, so leakage between tests would not just be
    // untidy — it would change the numbers being asserted.
    await db.exec('delete from public.creative_features')
    await db.exec('delete from public.jobs')
    await db.exec('delete from public.creatives')
  })

  async function seedCreative(
    hash: string,
    options: { mediaUrl?: string | null; mediaType?: string } = {},
  ): Promise<string> {
    const [creative] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, media_url)
       values ($1, $2, $3, $4::creative_media_type, $5) returning id`,
      [
        workspaceId,
        advertiserId,
        hash,
        options.mediaType ?? 'video',
        options.mediaUrl === undefined ? 'https://cdn.test/v.mp4?sig=abc' : options.mediaUrl,
      ],
    )
    return creative!.id
  }

  async function enqueue(version = 1, limit?: number): Promise<number> {
    const [row] = await db.query<{ n: number }>(
      limit === undefined
        ? 'select app.enqueue_pending_extractions($1::integer) as n'
        : 'select app.enqueue_pending_extractions($1::integer, $2::integer) as n',
      limit === undefined ? [version] : [version, limit],
    )
    return Number(row!.n)
  }

  async function insertFeatures(creativeId: string, version: number): Promise<void> {
    await db.query(
      `insert into public.creative_features (workspace_id, creative_id, schema_version)
       values ($1, $2, $3)`,
      [workspaceId, creativeId, version],
    )
  }

  async function jobRows(): Promise<
    { id: string; status: string; attempts: number; payload: Record<string, unknown> }[]
  > {
    return db.query('select id, status, attempts, payload from public.jobs order by created_at')
  }

  describe('app.enqueue_pending_extractions', () => {
    it('enqueues one extract job per creative with no features at that version', async () => {
      await seedCreative('tuple:a')
      await seedCreative('tuple:b')

      expect(await enqueue(1)).toBe(2)

      const jobs = await jobRows()
      expect(jobs).toHaveLength(2)
      expect(jobs.every((j) => j.status === 'pending')).toBe(true)
      expect(jobs[0]!.payload).toMatchObject({ schema_version: 1 })
    })

    it('stamps a message id, trace id and schedule actor on every job it creates', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)

      const [job] = await db.query<{
        message_id: string
        trace_id: string
        actor: { type: string; id: string }
        type: string
      }>('select message_id, trace_id, actor, type from public.jobs')

      // The §3 contracts are not optional for machine-minted work: without them the
      // extraction of a creative cannot be joined back to the tick that asked for it.
      expect(job!.type).toBe('extract')
      expect(job!.message_id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(job!.trace_id).toMatch(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(job!.actor).toMatchObject({ type: 'schedule', id: 'extract-reconciler' })
    })

    it('does not stack a second job while the first is still pending', async () => {
      await seedCreative('tuple:a')

      expect(await enqueue(1)).toBe(1)
      // The reconciler runs on a schedule; a tick that arrives before the worker has
      // drained the queue must find nothing to do, or a slow extraction would accumulate
      // one duplicate job per tick for as long as it runs.
      expect(await enqueue(1)).toBe(0)
      expect(await jobRows()).toHaveLength(1)
    })

    it('does not stack a second job while the first is running', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await db.exec("update public.jobs set status = 'running'")

      expect(await enqueue(1)).toBe(0)
    })

    it('re-enqueues after a failed attempt, because a failed job is not a result', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await db.exec("update public.jobs set status = 'failed'")

      // The creative still has no features row. Leaving it out would make a permanent
      // failure indistinguishable from a successful measurement that found nothing.
      expect(await enqueue(1)).toBe(1)
      expect(await jobRows()).toHaveLength(2)
    })

    it('skips a creative that already has features at that version', async () => {
      const withFeatures = await seedCreative('tuple:a')
      await seedCreative('tuple:b')
      await insertFeatures(withFeatures, 1)

      expect(await enqueue(1)).toBe(1)
      const jobs = await jobRows()
      expect(jobs[0]!.payload.creative_id).not.toBe(withFeatures)
    })

    it('treats a row at an older version as absent for the newer one', async () => {
      const creativeId = await seedCreative('tuple:a')
      await insertFeatures(creativeId, 1)

      // This is the whole version-bump path: v1 exists, v2 does not, so v2 is owed.
      expect(await enqueue(2)).toBe(1)
      const jobs = await jobRows()
      expect(jobs[0]!.payload).toMatchObject({ schema_version: 2 })
    })

    it('does not let a pending job for one version block another version', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)

      expect(await enqueue(2)).toBe(1)
      expect(await jobRows()).toHaveLength(2)
    })

    it('skips creatives with no media url — there is nothing to download', async () => {
      await seedCreative('tuple:a', { mediaUrl: null })

      expect(await enqueue(1)).toBe(0)
    })

    it(`skips media types outside ${CREATIVE_TYPES}`, async () => {
      await seedCreative('tuple:a', { mediaType: 'unknown' })

      // An 'unknown' media type means the parser could not tell what the asset was. Sending
      // it to the extractor produces a guaranteed failed job and three wasted attempts.
      expect(await enqueue(1)).toBe(0)
    })

    it('honors the batch limit so one tick cannot flood the queue', async () => {
      await seedCreative('tuple:a')
      await seedCreative('tuple:b')
      await seedCreative('tuple:c')

      expect(await enqueue(1, 2)).toBe(2)
      // The remainder is not lost — the next tick picks it up. That is the point of a
      // reconciler over a hook.
      expect(await enqueue(1, 2)).toBe(1)
    })
  })

  describe('app.mark_features_stale', () => {
    async function markStale(version: number): Promise<number> {
      const [row] = await db.query<{ n: number }>(
        'select app.mark_features_stale($1::integer) as n',
        [version],
      )
      return Number(row!.n)
    }

    it('marks rows below the target version and returns how many', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      await insertFeatures(a, 1)
      await insertFeatures(b, 1)

      expect(await markStale(2)).toBe(2)

      const rows = await db.query<{ is_stale: boolean }>(
        'select is_stale from public.creative_features',
      )
      expect(rows.every((r) => r.is_stale)).toBe(true)
    })

    it('leaves rows at or above the target version current', async () => {
      const a = await seedCreative('tuple:a')
      const b = await seedCreative('tuple:b')
      await insertFeatures(a, 1)
      await insertFeatures(b, 2)

      expect(await markStale(2)).toBe(1)

      const [current] = await db.query<{ is_stale: boolean }>(
        'select is_stale from public.creative_features where creative_id = $1',
        [b],
      )
      expect(current!.is_stale).toBe(false)
    })

    it('is idempotent — a repeated bump marks nothing new', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)

      expect(await markStale(2)).toBe(1)
      // Not just tidiness: the count is what the operator CLI prints, and a number that
      // grows on every re-run would misreport the size of the bump.
      expect(await markStale(2)).toBe(0)
    })

    it('keeps the superseded row readable rather than deleting it', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)
      await markStale(2)
      await insertFeatures(a, 2)

      const rows = await db.query<{ schema_version: number; is_stale: boolean }>(
        'select schema_version, is_stale from public.creative_features order by schema_version',
      )
      // Both versions coexist. Without the old row there is no way to tell a definition
      // change from a change in the media itself.
      expect(rows).toEqual([
        { schema_version: 1, is_stale: true },
        { schema_version: 2, is_stale: false },
      ])
    })

    it('does not enqueue anything by itself', async () => {
      const a = await seedCreative('tuple:a')
      await insertFeatures(a, 1)
      await markStale(2)

      // The split is deliberate. Staleness is recorded even if the re-extraction never
      // runs, so a worker outage cannot leave superseded rows presenting as current.
      expect(await jobRows()).toHaveLength(0)
    })
  })

  describe('app.claim_job', () => {
    async function claim(): Promise<
      { id: string; status: string; attempts: number; heartbeat_at: string | null }[]
    > {
      return db.query(
        `select id, status, attempts, heartbeat_at
         from app.claim_job(array['extract'])`,
      )
    }

    it('claims one due job and marks it running with a heartbeat', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)

      const claimed = await claim()

      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.status).toBe('running')
      expect(claimed[0]!.attempts).toBe(1)
      // Claimed without a heartbeat is worse than not claimed: the reaper only looks at
      // jobs that have reported once, so a null here means the job can never be recovered.
      expect(claimed[0]!.heartbeat_at).not.toBeNull()
    })

    it('returns zero rows when there is nothing to claim', async () => {
      // Regression guard. As a composite-returning function this call was re-evaluated
      // once per output column and "nothing to claim" arrived as a row of nulls, which
      // reads as a real job with a null id. SETOF makes the empty case unambiguous.
      expect(await claim()).toEqual([])
    })

    it('hands two workers two different jobs', async () => {
      await seedCreative('tuple:a')
      await seedCreative('tuple:b')
      await enqueue(1)

      const first = await claim()
      const second = await claim()
      const third = await claim()

      expect(first[0]!.id).not.toBe(second[0]!.id)
      expect(third).toEqual([])
    })

    it('leaves jobs whose backoff has not elapsed', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await db.exec("update public.jobs set run_after = now() + interval '5 minutes'")

      expect(await claim()).toEqual([])
    })

    it('ignores job types it was not asked for', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await db.exec("update public.jobs set type = 'crawl.watchlist'")

      // The extractor and the crawler poll the same table. A claim that ignored the type
      // filter would have the Python worker dequeue crawl jobs it cannot run.
      expect(await claim()).toEqual([])
    })

    it('preserves the original started_at across a retry', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)

      const [first] = await claim()
      const [before] = await db.query<{ started_at: string }>(
        'select started_at from public.jobs where id = $1',
        [first!.id],
      )

      await db.exec("update public.jobs set status = 'pending'")
      const [second] = await claim()

      const [after] = await db.query<{ started_at: string }>(
        'select started_at from public.jobs where id = $1',
        [second!.id],
      )
      expect(after!.started_at).toEqual(before!.started_at)
      expect(second!.attempts).toBe(2)
    })
  })

  describe('app.reap_stalled_jobs', () => {
    async function reap(stallAfter = '5 minutes'): Promise<number> {
      const [row] = await db.query<{ n: number }>(
        'select app.reap_stalled_jobs($1::interval) as n',
        [stallAfter],
      )
      return Number(row!.n)
    }

    async function claimOne(): Promise<string> {
      const [job] = await db.query<{ id: string }>(
        "select id from app.claim_job(array['extract'])",
      )
      return job!.id
    }

    it('requeues a running job whose worker went quiet', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      const jobId = await claimOne()
      await db.exec("update public.jobs set heartbeat_at = now() - interval '10 minutes'")

      expect(await reap()).toBe(1)

      const [job] = await db.query<{ status: string; last_error: string; finished_at: null }>(
        'select status, last_error, finished_at from public.jobs where id = $1',
        [jobId],
      )
      expect(job!.status).toBe('pending')
      expect(job!.last_error).toContain('stopped reporting')
      expect(job!.finished_at).toBeNull()
    })

    it('leaves a job that is still reporting alone', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await claimOne()

      // This is the case the heartbeat exists for: a transcription that takes minutes is
      // healthy, and reaping it would extract the same creative twice.
      expect(await reap()).toBe(0)
      const [job] = await db.query<{ status: string }>('select status from public.jobs')
      expect(job!.status).toBe('running')
    })

    it('fails a job for good once it has burned its attempts', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      await db.exec('update public.jobs set attempts = max_attempts')
      await db.exec("update public.jobs set status = 'running', heartbeat_at = now() - interval '1 hour'")

      expect(await reap()).toBe(1)

      const [job] = await db.query<{ status: string; finished_at: string | null }>(
        'select status, finished_at from public.jobs',
      )
      // A creative whose media reliably kills the extractor must stop consuming the queue
      // instead of cycling through it forever.
      expect(job!.status).toBe('failed')
      expect(job!.finished_at).not.toBeNull()
    })

    it('never touches a pending job', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)

      // A pending job is already claimable; reaping it would be a no-op at best and, once
      // finished_at starts being written, a lie about a job that never ran.
      expect(await reap('1 microsecond')).toBe(0)
    })

    it('never touches a running job that has not reported yet', async () => {
      await seedCreative('tuple:a')
      await enqueue(1)
      // Reachable by hand-repairing a stuck job, and by any future claim path that sets
      // status before its first heartbeat. Today the row is spared twice over: the explicit
      // null guard, and `null < now() - interval` evaluating to null anyway. Deleting the
      // guard does not break this test, and that is the point — the assertion is on the
      // behavior, so it holds whichever of the two mechanisms someone edits away.
      await db.exec("update public.jobs set status = 'running', heartbeat_at = null")

      expect(await reap('1 microsecond')).toBe(0)

      const [job] = await db.query<{ status: string }>('select status from public.jobs')
      expect(job!.status).toBe('running')
    })
  })
})
