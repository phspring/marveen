// The kanban routes and the ticket environments: with TICKET_ENVIRONMENTS off the dispatch is exactly today's; with it on, a
// card of an isolating project goes through its environment, everything else still takes today's path, and every way
// a card can leave the board asks for a reconcile.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const rt = { enabled: false, template: null as string | null, reconcile: vi.fn() }
const flow = { dispatch: vi.fn(), isolating: vi.fn() }
const inst = { of: null as null | { template: string } }

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin', BOT_NAME: 'Orin', OWNER_NAME: 'Owner',
}))
vi.mock('../db.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../db.js')>()), createAgentMessage: vi.fn() }))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex', 'dex-t1'],
  readAgentDisplayName: (n: string) => n,
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))
vi.mock('../web/agent-instance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-instance.js')>()),
  readInstanceOf: () => inst.of,
}))
vi.mock('../web/ticket-environment-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/ticket-environment-flow.js')>()),
  dispatchViaEnvironment: (...a: unknown[]) => flow.dispatch(...a),
  isolatingProjectOf: (...a: unknown[]) => flow.isolating(...a),
}))
vi.mock('../web/ticket-environment-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/ticket-environment-runtime.js')>()),
  ticketEnvironmentsEnabled: () => rt.enabled,
  makeTicketEnvironmentIO: () => ({ marker: 'io' }),
  resolveTemplateFor: () => rt.template,
  requestReconcile: () => rt.reconcile(),
}))

import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, createAgentMessage } from '../db.js'
import { tryHandleKanban, ticketDispatchBridge } from '../web/routes/kanban.js'

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 200
  let sent = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((chunk?: unknown) => { if (chunk != null) sent += String(chunk) }),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({ req, res, path, method, url: new URL(`http://localhost${path}`) } as never)
  expect(handled).toBe(true)
  return { status, body: sent ? JSON.parse(sent) as Record<string, unknown> : {} }
}
const move = (id: string, status: string, actor = 'orin') => call('POST', `/api/kanban/${id}/move`, { status, sort_order: 0, actor })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function messages(): Array<[string, string, string]> {
  return vi.mocked(createAgentMessage).mock.calls.map((c) => [c[0], c[1], c[2]] as [string, string, string])
}

beforeEach(() => {
  vi.clearAllMocks()
  rt.enabled = false; rt.template = null
  flow.dispatch.mockReset(); flow.isolating.mockReset()
  inst.of = null
  initDatabase(':memory:')
  createKanbanCard({ id: 't1', title: 'Ticket', assignee: 'dex', project: 'p', external_ref: 'TVR-1' })
})

describe('the switch is off: today\'s dispatch, unchanged', () => {
  it('a card moved to in_progress wakes the assignee directly, and no ticket-environment code is reached', async () => {
    await move('t1', 'in_progress')
    expect(messages()).toHaveLength(1)
    expect(messages()[0][0]).toBe('orin')
    expect(messages()[0][1]).toBe('dex')
    expect(messages()[0][2]).toContain('[Kanban feladat #t1]')
    expect(flow.dispatch).not.toHaveBeenCalled()
    expect(flow.isolating).not.toHaveBeenCalled()
    expect(getKanbanCard('t1')?.dispatched_at).not.toBeNull()
  })
})

describe('the switch is on', () => {
  beforeEach(() => { rt.enabled = true })

  it('a card of an isolating project goes through its environment: no direct message to the template', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    flow.dispatch.mockResolvedValue('dispatched')
    await move('t1', 'in_progress')
    await flush()
    expect(flow.dispatch).toHaveBeenCalledTimes(1)
    expect(flow.dispatch.mock.calls[0][0]).toMatchObject({ id: 't1', assignee: 'dex', project: 'p', external_ref: 'TVR-1' })
    expect(flow.dispatch.mock.calls[0][1]).toBe('dex')
    expect(messages()).toEqual([])
  })

  it('a card that is not in an isolating project takes today\'s path', async () => {
    flow.isolating.mockReturnValue(null)
    await move('t1', 'in_progress')
    expect(flow.dispatch).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(1)
    expect(messages()[0][1]).toBe('dex')
  })

  it('a card whose assignee is the main agent, or cannot be a template, takes today\'s path (and its alarms)', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = null
    await move('t1', 'in_progress')
    expect(flow.dispatch).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(1)
  })

  it('when the flow says the card is not its business after all (shared), today\'s dispatch follows', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    flow.dispatch.mockResolvedValue('shared')
    await move('t1', 'in_progress')
    await flush()
    expect(flow.dispatch).toHaveBeenCalledTimes(1)
    expect(messages()).toHaveLength(1)
    expect(messages()[0][1]).toBe('dex')
  })

  it('a queued, failed or busy outcome sends nothing here (the flow tells the card and the reconcile retries)', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    for (const outcome of ['queued', 'failed', 'busy']) {
      vi.mocked(createAgentMessage).mockClear()
      flow.dispatch.mockResolvedValue(outcome)
      await call('PUT', '/api/kanban/t1', { status: 'planned' })
      await move('t1', 'in_progress')
      await flush()
      expect(messages(), outcome).toEqual([])
    }
  })

  it('an instance that moves its own card to in_progress is picking it up: nothing is sent', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    inst.of = { template: 'dex' }
    await move('t1', 'in_progress', 'dex-t1')
    await flush()
    expect(flow.dispatch).not.toHaveBeenCalled()
    expect(messages()).toEqual([])
  })

  it('an instance of a DIFFERENT template moving the card does not suppress the dispatch', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    inst.of = { template: 'someone-else' }
    flow.dispatch.mockResolvedValue('dispatched')
    await move('t1', 'in_progress', 'dex-t1')
    await flush()
    expect(flow.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a flow that throws is reported on the card and to the main agent, and the move still succeeded', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    flow.dispatch.mockRejectedValue(new Error('disk full'))
    const r = await move('t1', 'in_progress')
    await flush()
    expect(r.status).toBe(200)
    expect(getKanbanCard('t1')?.status).toBe('in_progress')
    const alarm = messages().find((m) => m[0] === 'system')
    expect(alarm?.[1]).toBe('orin')
    expect(alarm?.[2]).toContain('[kanban-dispatch]')
    expect(getKanbanComments('t1').some((c) => c.content.includes('NEM kapott üzenetet'))).toBe(true)
  })

  it('moving the card is not delayed by the environment: the response is sent before the flow settles', async () => {
    flow.isolating.mockReturnValue({ name: 'p' })
    rt.template = 'dex'
    let release: (v: string) => void = () => {}
    flow.dispatch.mockReturnValue(new Promise<string>((res) => { release = res }))
    const r = await move('t1', 'in_progress')
    expect(r.status).toBe(200)
    expect(flow.dispatch).toHaveBeenCalledTimes(1)
    release('dispatched')
    await flush()
  })
})

describe('every way a card leaves the board asks for a reconcile', () => {
  it('a move, a PUT, an archive and a delete each request one (a no-op in the runtime while the switch is off)', async () => {
    createKanbanCard({ id: 't2', title: 'x', assignee: 'dex', status: 'in_progress' })
    await move('t2', 'done'); expect(rt.reconcile).toHaveBeenCalledTimes(1)
    await call('PUT', '/api/kanban/t2', { description: 'edited' }); expect(rt.reconcile).toHaveBeenCalledTimes(2)
    await call('POST', '/api/kanban/t2/archive', {}); expect(rt.reconcile).toHaveBeenCalledTimes(3)
    await call('DELETE', '/api/kanban/t2', {}); expect(rt.reconcile).toHaveBeenCalledTimes(4)
  })

  it('a request that changes nothing (a missing card) asks for nothing', async () => {
    await call('POST', '/api/kanban/nope/move', { status: 'done', sort_order: 0, actor: 'orin' })
    await call('POST', '/api/kanban/nope/archive', {})
    expect(rt.reconcile).not.toHaveBeenCalled()
  })
})

describe('ticketDispatchBridge.send: the message the instance gets', () => {
  it('is the usual card message addressed to the instance, plus where the work happens and how to use git there', () => {
    ticketDispatchBridge.send(
      { id: 't1', status: 'in_progress', archived_at: null, dispatched_at: null, assignee: 'dex', project: 'p' },
      'dex-t1', { workspace: '/ws/p/TVR-1', branch: 'feature/TVR-1', baseBranch: 'develop' },
    )
    expect(messages()).toHaveLength(1)
    const [from, to, text] = messages()[0]
    expect([from, to]).toEqual(['orin', 'dex-t1'])
    expect(text).toContain('[Kanban feladat #t1] felelős: dex-t1')
    expect(text).toContain('/ws/p/TVR-1')
    expect(text).toContain('git -C /ws/p/TVR-1')
    expect(text).toContain('feature/TVR-1')
    expect(text).toContain('Nem commitolsz')
    // the card's own text is still not in the message (KANBANASSIGNFRAME1008)
    expect(text).not.toContain('Ticket')
  })

  it('throws for a card that is gone or whose id is not of the dispatchable shape, so the flow reports it', () => {
    expect(() => ticketDispatchBridge.send({ id: 'gone', status: 'in_progress', archived_at: null, dispatched_at: null, assignee: 'dex', project: 'p' }, 'dex-t1', { workspace: '/w', branch: 'b', baseBranch: 'develop' })).toThrow()
    createKanbanCard({ id: 'bad.id', title: 'x' })
    expect(() => ticketDispatchBridge.send({ id: 'bad.id', status: 'in_progress', archived_at: null, dispatched_at: null, assignee: 'dex', project: 'p' }, 'dex-t1', { workspace: '/w', branch: 'b', baseBranch: 'develop' })).toThrow()
    expect(messages()).toEqual([])
  })
})
