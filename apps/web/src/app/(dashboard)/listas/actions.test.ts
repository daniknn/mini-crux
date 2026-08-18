import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The watchlist write path, above the database.
 *
 * The tenancy proof lives elsewhere: the policies are proved in `packages/db/test/tenant.
 * test.ts` and the connection wiring in `src/server/db.test.ts`. What is only provable here
 * is that the *action* never gives the caller a way to name a workspace or an actor. A form
 * post is attacker-controlled in full — every field, including ones the UI never renders —
 * so these tests read the exact arguments handed to the query layer and fail if anything
 * from the form reaches a field that should come from the session.
 *
 * Everything else here is the validation that stops a junk watchlist reaching the crawler.
 * A watchlist with an empty query is not a harmless empty row: the scheduler will pick it up
 * every day and spend a crawl on nothing.
 */

vi.mock('server-only', () => ({}))

const session = { clerkUserId: 'user_session' }

vi.mock('../../../server/db.ts', () => ({
  // `withWorkspace` is the seam the tenant enters through. Running the callback against a
  // sentinel executor proves the action never reaches around it for a connection.
  withWorkspace: <T>(fn: (db: unknown) => Promise<T>): Promise<T> => fn(EXECUTOR),
  currentClerkUserId: () => Promise.resolve(session.clerkUserId),
}))

const revalidated: string[] = []
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path)
  },
}))

const EXECUTOR = Symbol('sql-executor')

interface Call {
  db: unknown
  input: Record<string, unknown>
}

const calls: Record<string, Call[]> = { create: [], rename: [], setActive: [] }
/** What `renameWatchlist` / `setWatchlistActive` report back — `false` means RLS filtered it. */
let updateResult = true

vi.mock('@mini-crux/db/dashboard', () => ({
  createWatchlist: (db: unknown, input: Record<string, unknown>) => {
    calls['create']!.push({ db, input })
    return Promise.resolve({ id: 'wl_1', traceId: input['traceId'] })
  },
  renameWatchlist: (db: unknown, input: Record<string, unknown>) => {
    calls['rename']!.push({ db, input })
    return Promise.resolve(updateResult)
  },
  setWatchlistActive: (db: unknown, input: Record<string, unknown>) => {
    calls['setActive']!.push({ db, input })
    return Promise.resolve(updateResult)
  },
}))

const {
  createWatchlistAction,
  renameWatchlistAction,
  setWatchlistActiveAction,
} = await import('./actions.ts')

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

const VALID = { kind: 'keyword', query: 'tarjeta de crédito', label: 'Bancos MX', country: 'MX' }

beforeEach(() => {
  calls['create'] = []
  calls['rename'] = []
  calls['setActive'] = []
  revalidated.length = 0
  updateResult = true
  session.clerkUserId = 'user_session'
})

describe('createWatchlistAction', () => {
  it('creates the watchlist and reports it in Spanish', async () => {
    const result = await createWatchlistAction(null, form(VALID))

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Bancos MX')
    expect(calls['create']).toHaveLength(1)
    expect(calls['create']![0]!.input).toMatchObject({
      kind: 'keyword',
      query: 'tarjeta de crédito',
      label: 'Bancos MX',
      country: 'MX',
    })
    expect(revalidated).toEqual(['/listas'])
  })

  it('runs on the executor withWorkspace supplies, never one of its own', async () => {
    await createWatchlistAction(null, form(VALID))
    expect(calls['create']![0]!.db).toBe(EXECUTOR)
  })

  it('takes the actor from the session even when the form supplies one', async () => {
    session.clerkUserId = 'user_session'
    // A forged actor field, exactly as an attacker would post it. It has nowhere to land:
    // an audit row naming the wrong operator is a silent corruption of the audit log, which
    // is the one record that is supposed to survive a dispute.
    await createWatchlistAction(
      null,
      form({ ...VALID, clerkUserId: 'user_forged', workspaceId: 'ws_forged' }),
    )

    const { input } = calls['create']![0]!
    expect(input['clerkUserId']).toBe('user_session')
    expect(input).not.toHaveProperty('workspaceId')
  })

  it('mints a fresh trace id per action', async () => {
    await createWatchlistAction(null, form(VALID))
    await createWatchlistAction(null, form(VALID))

    const [first, second] = calls['create']!.map((c) => c.input['traceId'])
    expect(first).toMatch(/^trc_/)
    expect(second).toMatch(/^trc_/)
    expect(first).not.toBe(second)
  })

  it('refuses a kind the crawler cannot act on, without touching the database', async () => {
    const result = await createWatchlistAction(null, form({ ...VALID, kind: 'competitor' }))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('tipo')
    expect(calls['create']).toHaveLength(0)
    expect(revalidated).toEqual([])
  })

  it('refuses a missing kind', async () => {
    const result = await createWatchlistAction(null, form({ query: 'x', label: 'y' }))
    expect(result.ok).toBe(false)
    expect(calls['create']).toHaveLength(0)
  })

  // Whitespace, not emptiness. A label of three spaces passes an `=== ''` check on the raw
  // value and produces a watchlist that is invisible in the list it was created from.
  it.each([
    ['query', { ...VALID, query: '   ' }],
    ['label', { ...VALID, label: '   ' }],
  ])('refuses a whitespace-only %s', async (_field, fields) => {
    const result = await createWatchlistAction(null, form(fields))
    expect(result.ok).toBe(false)
    expect(calls['create']).toHaveLength(0)
  })

  it('trims the values it does accept', async () => {
    await createWatchlistAction(null, form({ ...VALID, query: '  banco  ', label: '  Bancos  ' }))
    expect(calls['create']![0]!.input).toMatchObject({ query: 'banco', label: 'Bancos' })
  })

  it('defaults the country to MX', async () => {
    const data = form({ kind: 'page', query: '12345', label: 'Competidor' })
    await createWatchlistAction(null, data)
    expect(calls['create']![0]!.input['country']).toBe('MX')
  })
})

describe('renameWatchlistAction', () => {
  it('renames and revalidates', async () => {
    const result = await renameWatchlistAction(null, form({ id: 'wl_1', label: 'Nuevo' }))

    expect(result).toEqual({ ok: true, message: 'Nombre actualizado.' })
    expect(calls['rename']![0]!.input).toMatchObject({
      id: 'wl_1',
      label: 'Nuevo',
      clerkUserId: 'user_session',
    })
    expect(revalidated).toEqual(['/listas'])
  })

  it('reports a filtered row as not found, and does not revalidate', async () => {
    // `false` is RLS refusing someone else's id. It reads the same as a typo'd id on
    // purpose: a distinguishable response turns this action into an oracle for which
    // watchlist ids exist in other workspaces.
    updateResult = false
    const result = await renameWatchlistAction(null, form({ id: 'wl_other', label: 'Nuevo' }))

    expect(result).toEqual({ ok: false, message: 'No encontramos esa lista.' })
    expect(revalidated).toEqual([])
  })

  it('refuses a whitespace-only label without touching the database', async () => {
    const result = await renameWatchlistAction(null, form({ id: 'wl_1', label: '  ' }))
    expect(result.ok).toBe(false)
    expect(calls['rename']).toHaveLength(0)
  })
})

describe('setWatchlistActiveAction', () => {
  it('pauses on "false" and says the observations are kept', async () => {
    const result = await setWatchlistActiveAction(null, form({ id: 'wl_1', isActive: 'false' }))

    expect(calls['setActive']![0]!.input['isActive']).toBe(false)
    expect(result.ok).toBe(true)
    // The copy is load-bearing: pausing is the closest thing this product has to a delete
    // button, and an operator who believes it destroys history will not use it.
    expect(result.message).toContain('conservan')
  })

  it('reactivates on "true"', async () => {
    const result = await setWatchlistActiveAction(null, form({ id: 'wl_1', isActive: 'true' }))

    expect(calls['setActive']![0]!.input['isActive']).toBe(true)
    expect(result.message).toContain('reactivada')
  })

  // Anything that is not the literal "true" is a pause. A missing field must never read as
  // "activate": the failure mode is a paused watchlist silently resuming and the operator
  // being billed for crawls they turned off.
  it.each([['absent', {}], ['garbage', { isActive: 'sí' }], ['numeric', { isActive: '1' }]])(
    'treats %s isActive as a pause',
    async (_case, fields) => {
      await setWatchlistActiveAction(null, form({ id: 'wl_1', ...fields }))
      expect(calls['setActive']![0]!.input['isActive']).toBe(false)
    },
  )

  it('reports a filtered row as not found', async () => {
    updateResult = false
    const result = await setWatchlistActiveAction(null, form({ id: 'wl_x', isActive: 'false' }))

    expect(result).toEqual({ ok: false, message: 'No encontramos esa lista.' })
    expect(revalidated).toEqual([])
  })

  it('stamps the session actor and a fresh trace id', async () => {
    await setWatchlistActiveAction(null, form({ id: 'wl_1', isActive: 'false', clerkUserId: 'x' }))
    const { input } = calls['setActive']![0]!
    expect(input['clerkUserId']).toBe('user_session')
    expect(input['traceId']).toMatch(/^trc_/)
  })
})
