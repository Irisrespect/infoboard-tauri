import { describe, it, expect, vi } from 'vitest'
import { eventBus } from '../core/eventBus'

describe('eventBus.emit', () => {
  it('payload 含循环引用时订阅者仍能收到事件', () => {
    const handler = vi.fn()
    const off = eventBus.on('t:circular', handler, 'test-circular')
    const payload: Record<string, unknown> = { a: 1 }
    payload.self = payload
    expect(() => eventBus.emit('t:circular', payload, 'src')).not.toThrow()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].payload).toBe(payload)
    off()
  })

  it('payload 含 BigInt 时订阅者仍能收到事件', () => {
    const handler = vi.fn()
    const off = eventBus.on('t:bigint', handler, 'test-bigint')
    expect(() => eventBus.emit('t:bigint', { n: 10n }, 'src')).not.toThrow()
    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it('普通 payload 行为不变', () => {
    const handler = vi.fn()
    const off = eventBus.on('t:plain', handler, 'test-plain')
    eventBus.emit('t:plain', { x: 1 }, 'src')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 't:plain',
      source: 'src',
      payload: { x: 1 },
    })
    off()
  })

  it('没有订阅者时不抛错', () => {
    const circ: Record<string, unknown> = {}
    circ.c = circ
    expect(() => eventBus.emit('t:nobody', circ, 'src')).not.toThrow()
  })
})
