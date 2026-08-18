import { describe, expect, it } from 'vitest'

import { isActor, operatorActor, scheduleActor, userActor } from '../src/actor.ts'

describe('actor constructors', () => {
  it('builds a user actor from a Clerk user id', () => {
    expect(userActor('user_123')).toEqual({ type: 'user', id: 'user_123' })
  })

  it('omits the label key entirely when none is given', () => {
    // Not `label: undefined` — the actor is serialized to jsonb, and an explicit null
    // would show up in every audit row.
    expect(Object.keys(userActor('user_123'))).toEqual(['type', 'id'])
    expect(Object.keys(userActor('user_123', 'Ana'))).toContain('label')
  })

  it('attributes the daily crawl to the watchlist it crawls', () => {
    expect(scheduleActor('wl_42')).toEqual({
      type: 'schedule',
      id: 'wl_42',
      label: 'daily-crawl',
    })
  })

  it('builds an operator actor', () => {
    expect(operatorActor('user_9', 'soporte')).toEqual({
      type: 'operator',
      id: 'user_9',
      label: 'soporte',
    })
  })
})

describe('isActor', () => {
  it('accepts every constructed actor', () => {
    for (const actor of [userActor('u'), scheduleActor('w'), operatorActor('o')]) {
      expect(isActor(actor)).toBe(true)
    }
  })

  it('accepts an agent actor', () => {
    expect(isActor({ type: 'agent', id: 'extractor' })).toBe(true)
  })

  it('rejects an unknown actor type', () => {
    expect(isActor({ type: 'robot', id: 'x' })).toBe(false)
  })

  it('rejects a missing or non-string id', () => {
    expect(isActor({ type: 'user' })).toBe(false)
    expect(isActor({ type: 'user', id: 42 })).toBe(false)
  })

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'user', 7, []]) {
      expect(isActor(value)).toBe(false)
    }
  })
})
