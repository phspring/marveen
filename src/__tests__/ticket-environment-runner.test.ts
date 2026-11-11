// The clock behind the ticket environments: a pass does nothing while the switch is off, never overlaps itself and
// never throws; the runner registers the handler the routes' requests reach; and web.ts really starts and stops it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sw = { on: false }
const reconcile = vi.fn()
const handlers: { fn: (() => void) | null } = { fn: null }

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/ticket-environment-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/ticket-environment-flow.js')>()),
  reconcileTicketEnvironments: (...a: unknown[]) => reconcile(...a),
}))
vi.mock('../web/ticket-environment-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/ticket-environment-runtime.js')>()),
  ticketEnvironmentsEnabled: () => sw.on,
  makeTicketEnvironmentIO: () => ({ marker: 'io' }),
  setReconcileHandler: (fn: (() => void) | null) => { handlers.fn = fn },
}))
vi.mock('../web/routes/kanban.js', () => ({ ticketDispatchBridge: { send: vi.fn(), reportUndelivered: vi.fn() } }))

import { reconcileOnce, startTicketEnvironmentRunner, stopTicketEnvironmentRunner } from '../web/ticket-environment-runner.js'
import { logger } from '../logger.js'

beforeEach(() => { vi.clearAllMocks(); sw.on = false; handlers.fn = null; reconcile.mockReset(); reconcile.mockResolvedValue({ released: [], kept: [], dispatched: [], errors: [] }) })
afterEach(() => { vi.useRealTimers() })

describe('reconcileOnce', () => {
  it('does nothing while the switch is off', async () => {
    await reconcileOnce()
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('runs one pass while it is on, with the live IO', async () => {
    sw.on = true
    await reconcileOnce()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0][0]).toEqual({ marker: 'io' })
  })

  it('never overlaps itself: a pass that is still running makes the next call a no-op', async () => {
    sw.on = true
    let finish: () => void = () => {}
    reconcile.mockReturnValue(new Promise<void>((res) => { finish = res }))
    const first = reconcileOnce()
    await reconcileOnce()
    expect(reconcile).toHaveBeenCalledTimes(1)
    finish()
    await first
    reconcile.mockResolvedValue({})
    await reconcileOnce()
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('a pass that throws is logged, does not escape, and does not block the next pass', async () => {
    sw.on = true
    reconcile.mockRejectedValueOnce(new Error('disk full'))
    await expect(reconcileOnce()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
    reconcile.mockResolvedValue({})
    await reconcileOnce()
    expect(reconcile).toHaveBeenCalledTimes(2)
  })
})

describe('the runner', () => {
  it('registers the handler the routes\' requests reach, runs after the initial delay and then every minute', async () => {
    vi.useFakeTimers()
    sw.on = true
    const timer = startTicketEnvironmentRunner()
    expect(handlers.fn).toBeTypeOf('function')

    await vi.advanceTimersByTimeAsync(44_000)
    expect(reconcile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)           // 46 s: the initial pass
    expect(reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)          // the 60 s interval
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(2)
    stopTicketEnvironmentRunner(timer)
  })

  it('a request through the handler runs a pass, and stopping removes the handler and the timer', async () => {
    vi.useFakeTimers()
    sw.on = true
    const timer = startTicketEnvironmentRunner()
    handlers.fn?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcile).toHaveBeenCalledTimes(1)

    stopTicketEnvironmentRunner(timer)
    expect(handlers.fn).toBeNull()
    reconcile.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('with the switch off the timer ticks and does nothing, and turning it on needs no restart', async () => {
    vi.useFakeTimers()
    const timer = startTicketEnvironmentRunner()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reconcile).not.toHaveBeenCalled()
    sw.on = true
    await vi.advanceTimersByTimeAsync(61_000)
    expect(reconcile).toHaveBeenCalled()
    stopTicketEnvironmentRunner(timer)
  })

  it('stopping without a timer is harmless', () => {
    expect(() => stopTicketEnvironmentRunner(undefined)).not.toThrow()
  })
})

describe('the wiring in web.ts (a runner that is never started frees nothing, silently)', () => {
  const webTs = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  const runnerTs = readFileSync(join(__dirname, '..', 'web', 'ticket-environment-runner.ts'), 'utf-8')

  it('web.ts imports the runner AND starts it, behind the same services gate as its neighbours', () => {
    expect(webTs).toContain("from './web/ticket-environment-runner.js'")
    expect(webTs).toMatch(/const ticketEnvironmentInterval = servicesOff \? undefined : startTicketEnvironmentRunner\(\)/)
  })

  it('the shutdown stops it, like the other runners', () => {
    expect(webTs).toMatch(/stopTicketEnvironmentRunner\(ticketEnvironmentInterval\)/)
  })

  it('the runner reconciles through the flow and reads the switch on every pass', () => {
    expect(runnerTs).toContain('reconcileTicketEnvironments')
    expect(runnerTs).toMatch(/if \(!ticketEnvironmentsEnabled\(\) \|\| running\) return/)
  })

  it('CONTROL: the search finds a neighbouring runner the same way, so the checks above cannot pass on an empty file', () => {
    expect(webTs).toMatch(/startKanbanArchiveRunner\(\)/)
    expect(webTs).toMatch(/clearInterval\(kanbanArchiveInterval\)/)
  })
})
