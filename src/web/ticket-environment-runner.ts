import { logger } from '../logger.js'
import { reconcileTicketEnvironments } from './ticket-environment-flow.js'
import { makeTicketEnvironmentIO, setReconcileHandler, ticketEnvironmentsEnabled } from './ticket-environment-runtime.js'
import { ticketDispatchBridge } from './routes/kanban.js'

// The clock behind the ticket environments (docs/jegy-kornyezet.md). Every minute, and shortly after a card
// leaves the active columns (the routes ask through requestReconcile), it brings the environments in step with the
// board: the ones whose card is done, planned, archived or gone are released, and the cards that had to wait for a
// slot (or failed) are tried again.
//
// It MUST be started from web.ts, or the feature silently stops freeing anything: a test asserts the wiring, as for
// its neighbouring runners. The switch (TICKET_ENVIRONMENTS) is read on every tick, so with it off the runner is a
// timer that does nothing, and turning it on needs no restart. The first pass is delayed like the neighbours' so
// boot is not a burst of work.

const INITIAL_DELAY_MS = 45_000
const INTERVAL_MS = 60_000

let running = false

/** One pass. Never overlaps itself, never throws, and does nothing while the switch is off. */
export async function reconcileOnce(): Promise<void> {
  if (!ticketEnvironmentsEnabled() || running) return
  running = true
  try {
    await reconcileTicketEnvironments(makeTicketEnvironmentIO(ticketDispatchBridge))
  } catch (err) {
    // best effort: the next tick retries, and silence here would be worse than the pass failing
    logger.error({ err }, 'Ticket environment reconcile failed')
  } finally {
    running = false
  }
}

let initialTimer: NodeJS.Timeout | null = null

export function startTicketEnvironmentRunner(): NodeJS.Timeout {
  setReconcileHandler(() => { void reconcileOnce() })
  if (initialTimer) clearTimeout(initialTimer)
  initialTimer = setTimeout(() => { initialTimer = null; void reconcileOnce() }, INITIAL_DELAY_MS)
  initialTimer.unref?.()
  return setInterval(() => { void reconcileOnce() }, INTERVAL_MS)
}

/** Stop the interval AND the delayed first pass, and unhook the requests: nothing runs after this. */
export function stopTicketEnvironmentRunner(timer: NodeJS.Timeout | undefined): void {
  if (timer) clearInterval(timer)
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null }
  setReconcileHandler(null)
}
