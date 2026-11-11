// The running-system side of the ticket environments (docs/jegy-kornyezet.md): the TICKET_ENVIRONMENTS switch, the
// FlowIO that reads the card table and starts and stops real sessions, and the debounced request to reconcile.
//
// Kept apart from the kanban routes so it has no import of them: the routes import this, and the runner that owns
// the timer imports both, so there is no cycle. The two things only the routes can build (the dispatch message and
// the "not woken" alarm) are handed in as a bridge.

import { MAIN_AGENT_ID, OWNER_NAME, BOT_NAME, RESERVED_AGENT_IDS } from '../config.js'
import { addKanbanComment, getDb, markKanbanCardDispatched } from '../db.js'
import { logger } from '../logger.js'
import { resolveKanbanDispatch, parseDispatchSkipAgents } from '../kanban-dispatch.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { isSettingOn } from '../setting-flag.js'
import { AGENTS_BASE_DIR, agentDir, listAgentNames } from './agent-config.js'
import { isAgentRunning, startAgentProcess, stopAgentProcess } from './agent-process.js'
import { readInstanceOf } from './agent-instance.js'
import { readProjectRegistry } from './project-store.js'
import type { FlowCard, FlowIO } from './ticket-environment-flow.js'

export const TICKET_ENVIRONMENTS_KEY = 'TICKET_ENVIRONMENTS'

/** The switch. Off (the default) means none of this runs and the kanban behaves exactly as before. Hot-reloaded. */
export function ticketEnvironmentsEnabled(): boolean {
  return isSettingOn(TICKET_ENVIRONMENTS_KEY)
}

/** What only the kanban routes can build: the dispatch message and the "assignee was not woken" alarm. */
export interface DispatchBridge {
  send: FlowIO['sendDispatch']
  reportUndelivered: FlowIO['reportUndelivered']
}

const CARD_COLUMNS = 'id, status, archived_at, dispatched_at, assignee, project, external_ref, scope'

// the active spell first: a ticket key can be on more than one card (a re-opened ticket), and any active one keeps it
const ACTIVE_FIRST = "CASE status WHEN 'in_progress' THEN 0 WHEN 'testing' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END"

/** The card that owns a ticket key (its external_ref or its id), the active one first; null when there is none. */
export function findCardByTicket(ticket: string): FlowCard | null {
  const row = getDb().prepare(
    `SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE (external_ref = ? OR id = ?) ORDER BY (archived_at IS NOT NULL), ${ACTIVE_FIRST}, updated_at DESC LIMIT 1`,
  ).get(ticket, ticket) as FlowCard | undefined
  return row ?? null
}

/** The scope text of the active card that owns a ticket key; null when none is declared or there is no such card. */
export function scopeOfTicket(ticket: string): string | null {
  const row = getDb().prepare(
    `SELECT scope FROM kanban_cards WHERE (external_ref = ? OR id = ?) AND archived_at IS NULL ORDER BY ${ACTIVE_FIRST}, updated_at DESC LIMIT 1`,
  ).get(ticket, ticket) as { scope: string | null } | undefined
  return row?.scope ?? null
}

/** Cards in_progress, not archived, never dispatched in this spell, that could belong to a project. */
export function listUndispatchedInProgress(): FlowCard[] {
  return getDb().prepare(
    `SELECT ${CARD_COLUMNS} FROM kanban_cards
      WHERE status = 'in_progress' AND archived_at IS NULL AND dispatched_at IS NULL
        AND (project IS NOT NULL OR external_ref IS NOT NULL)
      ORDER BY created_at ASC`,
  ).all() as FlowCard[]
}

/**
 * The agent a card's assignee names, resolved exactly as the dispatch resolves it, except that the agent need not be
 * running (its instance is what runs). The main agent is never a template: its cards take today's path.
 */
export function resolveTemplateFor(card: Pick<FlowCard, 'assignee'>, actor?: string | null): string | null {
  const decision = resolveKanbanDispatch(card.assignee, {
    ownerName: OWNER_NAME,
    botName: BOT_NAME,
    mainAgentId: MAIN_AGENT_ID,
    agentNames: listAgentNames(),
    isRunning: () => true,
    actor,
    skipAgents: parseDispatchSkipAgents(getEffectiveSettingValue('KANBAN_DISPATCH_SKIP_AGENTS')),
  })
  return decision.target && decision.target !== MAIN_AGENT_ID ? decision.target : null
}

/** Is `name` an agent made by this feature (an ephemeral instance)? */
export function isTicketInstance(name: string): boolean {
  try { return readInstanceOf(agentDir(name)) !== null } catch { return false }
}

/** The IO the flow runs on in the live system. The registry is read fresh on every call, so an edit applies at once. */
export function makeTicketEnvironmentIO(bridge: DispatchBridge): FlowIO {
  const comment = (cardId: string, text: string): void => {
    try { addKanbanComment(cardId, 'system', text, { automated: true }) } catch (err) {
      logger.warn({ err, cardId }, 'Ticket environment: the card comment could not be written')
    }
  }
  return {
    env: {
      registry: readProjectRegistry(),
      agentsBase: AGENTS_BASE_DIR,
      reservedIds: [MAIN_AGENT_ID, ...RESERVED_AGENT_IDS],
      scopeOfTicket: (ticket) => scopeOfTicket(ticket),
      // fresh: an instance never resumes a conversation; ownsResume: the dispatch message is its first prompt
      startAgent: (name) => startAgentProcess(name, { fresh: true, ownsResume: true }),
      stopAgent: (name) => stopAgentProcess(name),
      isRunning: (name) => isAgentRunning(name),
      comment,
    },
    resolveTemplate: (card) => resolveTemplateFor(card),
    isInstance: isTicketInstance,
    findCardByTicket,
    listUndispatchedInProgress,
    markDispatched: (id) => { markKanbanCardDispatched(id) },
    sendDispatch: bridge.send,
    reportUndelivered: bridge.reportUndelivered,
    log: logger,
  }
}

// --- the debounced request to reconcile -----------------------------------------------------------------------------
// A card that leaves the active columns (a move, a PUT, an archive, a delete) asks for a reconcile. Several in a row
// collapse into one, a couple of seconds later, so a burst of edits is one pass. The timer-owning runner registers the
// handler; with no handler (the runner is not running, or the feature is off) a request does nothing.

const RECONCILE_DEBOUNCE_MS = 2_000
let reconcileHandler: (() => void) | null = null
let reconcileTimer: NodeJS.Timeout | null = null

export function setReconcileHandler(fn: (() => void) | null): void {
  reconcileHandler = fn
  if (!fn && reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null }
}

export function requestReconcile(): void {
  if (!reconcileHandler || !ticketEnvironmentsEnabled() || reconcileTimer) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    try { reconcileHandler?.() } catch (err) { logger.warn({ err }, 'Ticket environment: the requested reconcile failed to start') }
  }, RECONCILE_DEBOUNCE_MS)
  reconcileTimer.unref?.()
}
