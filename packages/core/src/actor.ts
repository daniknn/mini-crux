/**
 * Who or what initiated a chain of work. Stamped at ingress and preserved end to end
 * (DashOne §3), so every audit row can answer "who caused this" without inference.
 */

export type ActorType = 'user' | 'schedule' | 'agent' | 'operator'

export interface Actor {
  type: ActorType
  /** Clerk user id for `user`; the watchlist/cron id for `schedule`; the agent name otherwise. */
  id: string
  /** Optional human-readable label, for rendering audit trails without a join. */
  label?: string
}

export function userActor(clerkUserId: string, label?: string): Actor {
  return { type: 'user', id: clerkUserId, ...(label === undefined ? {} : { label }) }
}

/** The daily crawl tick. `id` is the watchlist being crawled, so audit rows stay attributable. */
export function scheduleActor(watchlistId: string): Actor {
  return { type: 'schedule', id: watchlistId, label: 'daily-crawl' }
}

export function operatorActor(clerkUserId: string, label?: string): Actor {
  return { type: 'operator', id: clerkUserId, ...(label === undefined ? {} : { label }) }
}

export function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['type'] === 'string' &&
    ['user', 'schedule', 'agent', 'operator'].includes(candidate['type'])
  )
}
