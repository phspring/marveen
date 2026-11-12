// The dispatch side of the ticket environments (docs/jegy-kornyezet.md): what the kanban does with a card that went
// in_progress in an isolating project, and the safety net that keeps the environments in step with the board.
//
//   dispatchViaEnvironment: prepare the card's environment (src/web/ticket-environment.ts) and, when it is ready,
//                           send the card to the INSTANCE; a queued card is told why, a failed one is reported.
//   reconcileTicketEnvironments: release the environments whose card is no longer in progress (done, planned,
//                           archived, deleted) and retry the cards that had to wait. It is the one place that
//                           handles every way a card can leave the board's active columns (the routes, the
//                           archive sweep, a script writing the table), so none of them needs its own hook.
//
// Pure of the running system: every effect (sessions, the database, the dispatch message) comes in through `io`.
// Nothing here is reached unless TICKET_ENVIRONMENTS is on.

import { isolatesTickets, resolveProject, type ProjectConfig } from '../projects.js'
import { listAgentInstances } from './agent-instance.js'
import { listWorkspaces } from './workspace.js'
import {
  prepareTicketEnvironment, releaseTicketEnvironment, type EnvironmentDeps, type TicketCard,
} from './ticket-environment.js'

/** The card fields the dispatch reads (a KanbanCard satisfies this). */
export interface FlowCard {
  id: string
  status: string
  archived_at: number | null
  dispatched_at: number | null
  assignee: string | null
  project: string | null
  external_ref?: string | null
  scope?: string | null
}

export interface FlowIO {
  env: EnvironmentDeps
  /**
   * The CANONICAL agent id the card's assignee names: the agent's directory name under agents/ (lower case, as
   * sanitizeAgentName makes it), never a display label. It is passed on as the template of the instance, and a
   * label would be refused there ("invalid template name"). Null when the assignee names nobody dispatchable.
   * The live implementation resolves a display name or any casing to that id.
   */
  resolveTemplate: (card: FlowCard) => string | null
  /** An agent that is itself an instance cannot be a template: the card takes today's path. */
  isInstance: (agent: string) => boolean
  /** The card that owns a ticket key (its external_ref or its id), the active one first; null when none. */
  findCardByTicket: (ticket: string) => FlowCard | null
  /** Cards in_progress, not archived, never dispatched in this spell: the ones waiting for a slot or a retry. */
  listUndispatchedInProgress: () => FlowCard[]
  markDispatched: (cardId: string) => void
  /** The dispatch message to the instance (the card id, the move recipe, the workspace and its literal path). */
  sendDispatch: (card: FlowCard, instance: string, info: { workspace: string; branch: string; baseBranch: string }) => void
  /** A card that is in_progress but whose assignee was NOT woken must never stay silent. */
  reportUndelivered: (cardId: string, why: string) => void
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }
  now?: () => number
}

export type DispatchOutcome = 'dispatched' | 'queued' | 'failed' | 'shared' | 'busy'

/** Statuses in which a ticket keeps its environment: the work is not over (a test, a review, a wait). */
export const ACTIVE_STATUSES: readonly string[] = ['in_progress', 'waiting', 'testing']

// In-process memory, deliberately: a restart forgets it, which costs at most one repeated notice.
const inFlight = new Set<string>()
const queuedNote = new Map<string, string>()
const failures = new Map<string, { count: number; retryAt: number }>()
const MAX_BACKOFF_MS = 30 * 60_000

/** Forget everything remembered (tests, and a restart of the feature). */
export function resetTicketEnvironmentFlow(): void {
  inFlight.clear(); queuedNote.clear(); failures.clear()
}

/** Forget what is remembered about every card that is not in `keep`, except one being prepared right now. */
function forgetCardsNotIn(keep: ReadonlySet<string>): void {
  for (const id of [...queuedNote.keys()]) if (!keep.has(id) && !inFlight.has(id)) queuedNote.delete(id)
  for (const id of [...failures.keys()]) if (!keep.has(id) && !inFlight.has(id)) failures.delete(id)
}

function toTicketCard(c: FlowCard): TicketCard {
  return { id: c.id, project: c.project, external_ref: c.external_ref ?? null, scope: c.scope ?? null }
}

/** The isolating project a card belongs to, or null (then it is not this feature's business). */
export function isolatingProjectOf(card: FlowCard, io: Pick<FlowIO, 'env'>): ProjectConfig | null {
  const r = resolveProject({ project: card.project, externalRef: card.external_ref ?? null }, io.env.registry)
  return r && isolatesTickets(r.project) ? r.project : null
}

function backoffMs(count: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, count - 1))
}

function noteFailure(card: FlowCard, why: string, io: FlowIO): void {
  const now = (io.now ?? Date.now)()
  const prev = failures.get(card.id)
  const count = (prev?.count ?? 0) + 1
  failures.set(card.id, { count, retryAt: now + backoffMs(count) })
  // reported on the first failure and then rarely: every minute would bury the one case that matters
  if (count === 1 || count === 5) io.reportUndelivered(card.id, why)
  io.log.warn({ id: card.id, count, why }, 'Ticket environment: the card could not be dispatched')
}

/**
 * Dispatch a card that went in_progress, through its ticket environment. `template` is the agent the card is
 * assigned to; the work goes to an instance of it.
 *   shared     not this feature's card, take today's path;
 *   busy       the same card is already being prepared;
 *   queued     it has to wait (told on the card, retried by the reconcile);
 *   failed     reported, retried with a growing delay;
 *   dispatched the instance was sent the card (the once-only guard is set only now).
 */
export async function dispatchViaEnvironment(card: FlowCard, template: string, io: FlowIO): Promise<DispatchOutcome> {
  if (io.isInstance(template)) return 'shared'
  if (!isolatingProjectOf(card, io)) return 'shared'
  if (inFlight.has(card.id)) return 'busy'
  inFlight.add(card.id)
  try {
    const r = await prepareTicketEnvironment(toTicketCard(card), template, io.env)
    if (r.kind === 'shared') return 'shared'

    if (r.kind === 'queued') {
      const why = r.reason === 'capacity'
        ? `a projekt (${r.project}) elérte az egyszerre futó jegyek számát (${r.waitingFor.join(', ')} foglalja a helyeket)`
        : r.reason === 'overlap'
          ? `átfedő vagy ismeretlen fájlkörű jegy fut (${r.waitingFor.join(', ')}); a vezető töltse ki a kártya fájlkörét (scope), vagy várjon a jegy lezárására`
          : `építeni kellene a(z) ${r.waitingFor.join(', ')} jegyre, de ez klón (almodul) projektben nem lehetséges`
      const key = `${r.reason}:${r.waitingFor.join(',')}`
      if (queuedNote.get(card.id) !== key) {
        queuedNote.set(card.id, key)
        io.env.comment(card.id, `A jegy vár, nem indult el: ${why}. A felszabaduló hely után magától indul.`)
      }
      return 'queued'
    }

    if (r.kind === 'failed') {
      noteFailure(card, `jegy-környezet: ${r.error}`, io)
      return 'failed'
    }

    io.sendDispatch(card, r.instance, { workspace: r.workspace, branch: r.branch, baseBranch: r.baseBranch })
    io.markDispatched(card.id)
    queuedNote.delete(card.id)
    failures.delete(card.id)
    return 'dispatched'
  } catch (err) {
    noteFailure(card, `jegy-környezet: ${err instanceof Error ? err.message : String(err)}`, io)
    return 'failed'
  } finally {
    inFlight.delete(card.id)
  }
}

export interface ReconcileReport {
  released: string[]
  /** Tickets whose workspace was kept because it holds unsaved work. */
  kept: string[]
  /** Cards that had been waiting (or had failed) and were dispatched now. */
  dispatched: string[]
  errors: string[]
}

/**
 * Bring the environments in step with the board:
 *  1. every environment whose card is not in an active column (or does not exist) is released, never forced: a
 *     workspace with unsaved work is kept and reported;
 *  2. every card that is in_progress and was never dispatched (it had to wait, or it failed) is tried again.
 */
export async function reconcileTicketEnvironments(io: FlowIO): Promise<ReconcileReport> {
  const report: ReconcileReport = { released: [], kept: [], dispatched: [], errors: [] }
  const now = (io.now ?? Date.now)()

  for (const project of io.env.registry.projects.filter(isolatesTickets)) {
    const tickets = new Set<string>([
      ...listWorkspaces(project).map((m) => m.ticket),
      ...listAgentInstances(io.env.agentsBase).filter((i) => i.of.project === project.name).map((i) => i.of.ticket),
    ])
    for (const ticket of tickets) {
      const card = io.findCardByTicket(ticket)
      if (card && card.archived_at == null && ACTIVE_STATUSES.includes(card.status)) continue
      const ticketCard: TicketCard = { id: card?.id ?? ticket, project: project.name, external_ref: ticket, scope: null }
      try {
        const r = await releaseTicketEnvironment(ticketCard, io.env)
        if (!r.ok) { report.errors.push(`${ticket}: ${r.error}`); continue }
        if (r.released) report.released.push(ticket)
        // kept: the pass that first finds the workspace held back; the same one on later passes is not news
        if (r.keptWorkspace && r.keptNew) report.kept.push(ticket)
      } catch (err) {
        report.errors.push(`${ticket}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const waiting = io.listUndispatchedInProgress()
  // What was remembered about a card is only good for the spell it was remembered in. A card that left in_progress
  // without being dispatched (moved back, done, archived, deleted) is forgotten here: otherwise the maps grow for as
  // long as the process lives, and, worse, a card that comes back and waits for the same reason would not be told
  // again (the note would look like a repeat), and would inherit the old retry delay.
  forgetCardsNotIn(new Set(waiting.map((c) => c.id)))

  for (const card of waiting) {
    if (!isolatingProjectOf(card, io)) continue
    const f = failures.get(card.id)
    if (f && f.retryAt > now) continue
    const template = io.resolveTemplate(card)
    if (!template) continue
    const outcome = await dispatchViaEnvironment(card, template, io)
    if (outcome === 'dispatched') report.dispatched.push(card.id)
  }

  if (report.released.length > 0 || report.dispatched.length > 0 || report.kept.length > 0 || report.errors.length > 0) {
    io.log.info({ ...report }, 'Ticket environments reconciled')
  }
  return report
}
