import { newMessageId, newTraceId, scheduleActor } from '@mini-crux/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appendAuditEvent, findAuditEventsByTrace } from '../src/audit.ts'
import { enqueueJob, withIdempotency } from '../src/jobs.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'
import type { SqlExecutor } from '../src/types.ts'

describe('durable work contracts', () => {
  let db: TestDb
  let workspaceId: string

  beforeAll(async () => {
    db = await createTestDb()
    const seeded = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: 'org_acme',
      clerkUserId: 'user_acme',
    })
    workspaceId = seeded.workspaceId
  })

  afterAll(async () => {
    await db.close()
  })

  describe('enqueueJob', () => {
    it('mints a message id when none is supplied', async () => {
      const result = await enqueueJob(db, {
        workspaceId,
        type: 'crawl.watchlist',
        traceId: newTraceId(),
        actor: scheduleActor('wl_1'),
      })

      expect(result.enqueued).toBe(true)
      expect(result.messageId).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
    })

    it('is a no-op on redelivery of the same message id', async () => {
      const messageId = newMessageId()
      const input = {
        workspaceId,
        type: 'crawl.watchlist',
        traceId: newTraceId(),
        actor: scheduleActor('wl_2'),
        messageId,
      }

      const first = await enqueueJob(db, input)
      const second = await enqueueJob(db, input)

      expect(first.enqueued).toBe(true)
      expect(second.enqueued).toBe(false)
      // Same row, not a second one — the caller can act on the id either way.
      expect(second.jobId).toBe(first.jobId)

      const rows = await db.query<{ count: string }>(
        'select count(*)::text as count from public.jobs where message_id = $1',
        [messageId],
      )
      expect(rows[0]!.count).toBe('1')
    })

    it('stores the trace id, actor and schema version on the row', async () => {
      const traceId = newTraceId()
      const actor = scheduleActor('wl_3')

      const { jobId } = await enqueueJob(db, {
        workspaceId,
        type: 'crawl.watchlist',
        traceId,
        actor,
        payload: { watchlistId: 'wl_3' },
        schemaVersion: 2,
      })

      const [row] = await db.query<{
        trace_id: string
        actor: { type: string; id: string }
        schema_version: number
        payload: { watchlistId: string }
      }>(
        'select trace_id, actor, schema_version, payload from public.jobs where id = $1',
        [jobId],
      )

      expect(row!.trace_id).toBe(traceId)
      expect(row!.actor).toMatchObject({ type: 'schedule', id: 'wl_3' })
      expect(row!.schema_version).toBe(2)
      expect(row!.payload).toEqual({ watchlistId: 'wl_3' })
    })
  })

  describe('withIdempotency', () => {
    it('runs the side effect exactly once across redeliveries', async () => {
      const messageId = newMessageId()
      const traceId = newTraceId()
      let calls = 0

      const key = { messageId, workspaceId, traceId }
      const sideEffect = async (tx: SqlExecutor): Promise<string> => {
        calls += 1
        await tx.query(
          `insert into public.audit_events (workspace_id, trace_id, actor, type)
           values ($1, $2, $3, 'test.side_effect')`,
          [workspaceId, traceId, JSON.stringify({ type: 'agent', id: 'worker' })],
        )
        return 'done'
      }

      const first = await withIdempotency(db, key, sideEffect)
      const second = await withIdempotency(db, key, sideEffect)

      expect(first).toEqual({ applied: true, result: 'done' })
      expect(second).toEqual({ applied: false })
      expect(calls).toBe(1)

      const events = await findAuditEventsByTrace(db, traceId)
      expect(events).toHaveLength(1)
    })

    it('leaves no ledger row behind when the side effect throws', async () => {
      const messageId = newMessageId()
      const key = { messageId, workspaceId, traceId: newTraceId() }

      await expect(
        withIdempotency(db, key, async () => {
          throw new Error('provider timed out')
        }),
      ).rejects.toThrow('provider timed out')

      const ledger = await db.query(
        'select message_id from public.processed_messages where message_id = $1',
        [messageId],
      )
      // The ledger row rolled back with the effect, so a retry can still succeed.
      expect(ledger).toEqual([])

      const retry = await withIdempotency(db, key, async () => 'recovered')
      expect(retry).toEqual({ applied: true, result: 'recovered' })
    })
  })

  describe('audit log', () => {
    it('is queryable by trace id, oldest first', async () => {
      const traceId = newTraceId()
      const actor = scheduleActor('wl_audit')

      await appendAuditEvent(db, { workspaceId, traceId, actor, type: 'crawl.started' })
      await appendAuditEvent(db, {
        workspaceId,
        traceId,
        actor,
        type: 'crawl.completed',
        subjectType: 'watchlist',
        subjectId: 'wl_audit',
        payload: { adsSeen: 42 },
      })
      // A different trace must not bleed into the result.
      await appendAuditEvent(db, {
        workspaceId,
        traceId: newTraceId(),
        actor,
        type: 'crawl.started',
      })

      const events = await findAuditEventsByTrace(db, traceId)

      expect(events.map((e) => e.type)).toEqual(['crawl.started', 'crawl.completed'])
      expect(events[1]!.subject_id).toBe('wl_audit')
      expect(events[1]!.payload).toEqual({ adsSeen: 42 })
      expect(events[0]!.schema_version).toBe(1)
      expect(events[0]!.actor).toMatchObject({ type: 'schedule', id: 'wl_audit' })
    })

    it('is queryable by actor', async () => {
      const rows = await db.query<{ count: string }>(
        `select count(*)::text as count from public.audit_events
         where actor @> $1`,
        [JSON.stringify({ type: 'agent' })],
      )
      expect(Number(rows[0]!.count)).toBeGreaterThan(0)
    })
  })
})
