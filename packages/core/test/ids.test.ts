import { describe, expect, it } from 'vitest'

import {
  isMessageId,
  isTraceId,
  MESSAGE_PREFIX,
  newMessageId,
  newTraceId,
  TRACE_PREFIX,
} from '../src/ids.ts'

describe('trace ids', () => {
  it('mints a prefixed ULID', () => {
    const id = newTraceId()
    expect(id.startsWith(TRACE_PREFIX)).toBe(true)
    expect(isTraceId(id)).toBe(true)
  })

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTraceId()))
    expect(ids.size).toBe(500)
  })

  it('sorts lexicographically by creation time', async () => {
    // `ulid()` is not monotonic *within* a millisecond — the random tail can go either
    // way — so the ordering guarantee we rely on is across milliseconds. Sleep past the
    // timestamp boundary and assert it there.
    const first = newTraceId()
    await new Promise((resolve) => setTimeout(resolve, 3))
    const second = newTraceId()

    expect(first < second).toBe(true)
  })

  it('rejects a message id', () => {
    expect(isTraceId(newMessageId())).toBe(false)
  })

  it('rejects a bare ULID and a truncated id', () => {
    expect(isTraceId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false)
    expect(isTraceId(`${TRACE_PREFIX}01ARZ3NDEK`)).toBe(false)
  })
})

describe('message ids', () => {
  it('mints a prefixed ULID', () => {
    const id = newMessageId()
    expect(id.startsWith(MESSAGE_PREFIX)).toBe(true)
    expect(isMessageId(id)).toBe(true)
  })

  it('rejects a trace id', () => {
    expect(isMessageId(newTraceId())).toBe(false)
  })
})
