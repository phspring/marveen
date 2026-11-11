// The running-system side of the ticket environments: the switch, the card queries, the template resolution and the
// debounced request to reconcile. The database is a real in-memory one; sessions and agents are faked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const switchValue = { v: '0' }
const agentNames = { v: ['cpp-developer', 'cpp-tester'] as string[] }

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin', BOT_NAME: 'Orin', OWNER_NAME: 'Owner',
}))
vi.mock('../settings-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (key: string) => (key === 'TICKET_ENVIRONMENTS' ? switchValue.v : ''),
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => agentNames.v,
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => false,
  startAgentProcess: vi.fn(async () => ({ ok: true })),
  stopAgentProcess: vi.fn(async () => ({ ok: true })),
}))

import { initDatabase, createKanbanCard, updateKanbanCard, archiveKanbanCard, getKanbanCard, getDb } from '../db.js'
import {
  ticketEnvironmentsEnabled, findCardByTicket, scopeOfTicket, listUndispatchedInProgress, resolveTemplateFor,
  makeTicketEnvironmentIO, requestReconcile, setReconcileHandler,
} from '../web/ticket-environment-runtime.js'

beforeEach(() => {
  vi.clearAllMocks()
  switchValue.v = '0'
  agentNames.v = ['cpp-developer', 'cpp-tester']
  initDatabase(':memory:')
})
afterEach(() => { setReconcileHandler(null); vi.useRealTimers() })

describe('the switch', () => {
  it('is off by default and reads 1, true, yes and on as on, on every call (no restart)', () => {
    expect(ticketEnvironmentsEnabled()).toBe(false)
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) { switchValue.v = v; expect(ticketEnvironmentsEnabled(), v).toBe(true) }
    for (const v of ['0', '', 'no', 'off', 'maybe']) { switchValue.v = v; expect(ticketEnvironmentsEnabled(), v).toBe(false) }
  })
})

describe('the card queries', () => {
  it('findCardByTicket matches the external reference or the card id, the active card first, archived last', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'old', external_ref: 'TVR-1', project: 'p' })
    archiveKanbanCard('aaaa1111')
    createKanbanCard({ id: 'bbbb2222', title: 'reopened', external_ref: 'TVR-1', project: 'p', status: 'done' })
    createKanbanCard({ id: 'cccc3333', title: 'active', external_ref: 'TVR-1', project: 'p', status: 'in_progress' })
    expect(findCardByTicket('TVR-1')?.id).toBe('cccc3333')
    expect(findCardByTicket('bbbb2222')?.id).toBe('bbbb2222')
    expect(findCardByTicket('NOPE-1')).toBeNull()
    updateKanbanCard('cccc3333', { status: 'testing' })
    expect(findCardByTicket('TVR-1')?.id).toBe('cccc3333')
    updateKanbanCard('cccc3333', { status: 'done' })
    // done ties with the other done card: the more recently updated one wins, and the archived card never does
    expect(['bbbb2222', 'cccc3333']).toContain(findCardByTicket('TVR-1')?.id)
    expect(findCardByTicket('TVR-1')?.archived_at).toBeNull()
  })

  it('findCardByTicket carries exactly the fields the flow reads', () => {
    createKanbanCard({ id: 'dddd4444', title: 'x', external_ref: 'TVR-4', scope: 'src', project: 'p', assignee: 'cpp-developer', status: 'in_progress' })
    expect(findCardByTicket('TVR-4')).toEqual({
      id: 'dddd4444', status: 'in_progress', archived_at: null, dispatched_at: null, assignee: 'cpp-developer', project: 'p', external_ref: 'TVR-4', scope: 'src',
    })
  })

  it('scopeOfTicket reads the active card\'s scope, and null when it has none, is archived or does not exist', () => {
    createKanbanCard({ id: 'eeee5555', title: 'x', external_ref: 'TVR-5', scope: 'src/a\nsrc/b', status: 'in_progress' })
    createKanbanCard({ id: 'ffff6666', title: 'y', external_ref: 'TVR-6', status: 'in_progress' })
    createKanbanCard({ id: 'gggg7777', title: 'z', external_ref: 'TVR-7', scope: 'docs', status: 'in_progress' })
    archiveKanbanCard('gggg7777')
    expect(scopeOfTicket('TVR-5')).toBe('src/a\nsrc/b')
    expect(scopeOfTicket('TVR-6')).toBeNull()
    expect(scopeOfTicket('TVR-7')).toBeNull()
    expect(scopeOfTicket('NOPE')).toBeNull()
  })

  it('listUndispatchedInProgress: in progress, not archived, never dispatched, oldest first, with a project or a reference', () => {
    createKanbanCard({ id: 'h1', title: 'a', project: 'p', status: 'in_progress' })
    createKanbanCard({ id: 'h2', title: 'b', external_ref: 'TVR-2', status: 'in_progress' })
    createKanbanCard({ id: 'h3', title: 'no project, no ref', status: 'in_progress' })
    createKanbanCard({ id: 'h4', title: 'planned', project: 'p', status: 'planned' })
    createKanbanCard({ id: 'h5', title: 'dispatched', project: 'p', status: 'in_progress' })
    createKanbanCard({ id: 'h6', title: 'archived', project: 'p', status: 'in_progress' })
    getDb().prepare('UPDATE kanban_cards SET dispatched_at = 1 WHERE id = ?').run('h5')
    archiveKanbanCard('h6')
    getDb().prepare('UPDATE kanban_cards SET created_at = created_at + ? WHERE id = ?').run(10, 'h2')
    expect(listUndispatchedInProgress().map((c) => c.id)).toEqual(['h1', 'h2'])
  })
})

describe('resolveTemplateFor', () => {
  it('names the assigned agent even when it is not running (its instance is what runs)', () => {
    expect(resolveTemplateFor({ assignee: 'cpp-developer' })).toBe('cpp-developer')
    expect(resolveTemplateFor({ assignee: 'CPP-Developer' })).toBe('cpp-developer')
  })

  it('is null for the main agent, the owner, nobody and an unknown name', () => {
    for (const a of ['orin', 'Orin', 'Owner', null, '', 'ghost']) expect(resolveTemplateFor({ assignee: a }), String(a)).toBeNull()
  })

  it('honours the mover: an agent that moves its own card is not woken', () => {
    expect(resolveTemplateFor({ assignee: 'cpp-developer' }, 'cpp-developer')).toBeNull()
    expect(resolveTemplateFor({ assignee: 'cpp-developer' }, 'cpp-tester')).toBe('cpp-developer')
  })
})

describe('makeTicketEnvironmentIO', () => {
  const bridge = { send: vi.fn(), reportUndelivered: vi.fn() }

  it('hands the bridge through untouched and reserves the main agent', () => {
    const io = makeTicketEnvironmentIO(bridge)
    expect(io.sendDispatch).toBe(bridge.send)
    expect(io.reportUndelivered).toBe(bridge.reportUndelivered)
    expect(io.env.reservedIds).toContain('orin')
  })

  it('a card comment that cannot be written (no such card) is swallowed, not thrown into the flow', () => {
    const io = makeTicketEnvironmentIO(bridge)
    expect(() => io.env.comment('no-such-card', 'text')).not.toThrow()
  })

  it('a comment on a real card is written as an automated system comment', () => {
    createKanbanCard({ id: 'i1', title: 'x' })
    makeTicketEnvironmentIO(bridge).env.comment('i1', 'Jegy-környezet kész.')
    const row = getDb().prepare('SELECT author, content, automated FROM kanban_comments WHERE card_id = ?').get('i1') as { author: string; content: string; automated: number }
    expect(row).toEqual({ author: 'system', content: 'Jegy-környezet kész.', automated: 1 })
  })

  it('markDispatched sets the once-only guard on the card', () => {
    createKanbanCard({ id: 'j1', title: 'x', status: 'in_progress' })
    makeTicketEnvironmentIO(bridge).markDispatched('j1')
    expect(getKanbanCard('j1')?.dispatched_at).not.toBeNull()
  })
})

describe('requestReconcile', () => {
  it('does nothing without a handler, and nothing while the switch is off', () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    requestReconcile()                                   // no handler
    setReconcileHandler(handler)
    requestReconcile()                                   // switch off
    vi.advanceTimersByTime(10_000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('a burst of requests is one pass, a couple of seconds later', () => {
    vi.useFakeTimers()
    switchValue.v = '1'
    const handler = vi.fn()
    setReconcileHandler(handler)
    for (let i = 0; i < 10; i++) requestReconcile()
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_900)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(handler).toHaveBeenCalledTimes(1)
    requestReconcile()
    vi.advanceTimersByTime(2_100)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('removing the handler cancels a pending request, and a throwing handler never escapes', () => {
    vi.useFakeTimers()
    switchValue.v = '1'
    const handler = vi.fn()
    setReconcileHandler(handler)
    requestReconcile()
    setReconcileHandler(null)
    vi.advanceTimersByTime(5_000)
    expect(handler).not.toHaveBeenCalled()

    setReconcileHandler(() => { throw new Error('boom') })
    requestReconcile()
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
  })
})
