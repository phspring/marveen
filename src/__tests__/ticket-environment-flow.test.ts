// The dispatch side of the ticket environments: dispatch through an environment, and the reconcile that releases what the
// board no longer needs and retries what had to wait. Real git and a real agents directory, the sessions and the
// database faked.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectRegistry } from '../projects.js'
import { listAgentInstances } from '../web/agent-instance.js'
import { listWorkspaces } from '../web/workspace.js'
import type { EnvironmentDeps } from '../web/ticket-environment.js'
import {
  dispatchViaEnvironment, reconcileTicketEnvironments, resetTicketEnvironmentFlow, isolatingProjectOf,
  type FlowCard, type FlowIO,
} from '../web/ticket-environment-flow.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] } })
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}

let base: string
let agentsBase: string
let cards: Map<string, FlowCard>
let running: Set<string>
let comments: Array<[string, string]>
let sent: Array<{ card: string; instance: string; workspace: string; branch: string; baseBranch: string }>
let reported: Array<[string, string]>
let startFails: string | null
let sendThrows: boolean
let clock: number

function makeRegistry(extra: Record<string, unknown> = {}): ProjectRegistry {
  return normalizeProjectRegistry({
    projects: {
      p: { repoPath: join(base, 'repo'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 2, jiraKeys: ['TVR'], ...extra },
      shared: { repoPath: join(base, 'other'), mode: 'shared' },
    },
  })
}

function makeIO(registry: ProjectRegistry): FlowIO {
  const env: EnvironmentDeps = {
    registry, agentsBase, reservedIds: ['marveen'],
    scopeOfTicket: (t) => {
      for (const c of cards.values()) if ((c.external_ref === t || c.id === t) && c.archived_at == null) return c.scope ?? null
      return null
    },
    startAgent: async (n) => {
      if (startFails) return { ok: false, error: startFails }
      running.add(n); return { ok: true }
    },
    stopAgent: async (n) => { running.delete(n); return { ok: true } },
    isRunning: (n) => running.has(n),
    comment: (id, text) => { comments.push([id, text]) },
  }
  const rank = (s: string) => (s === 'in_progress' ? 0 : s === 'testing' ? 1 : s === 'waiting' ? 2 : 3)
  return {
    env,
    resolveTemplate: (c) => (c.assignee && c.assignee !== 'nobody' ? c.assignee : null),
    isInstance: (n) => listAgentInstances(agentsBase).some((i) => i.name === n),
    findCardByTicket: (t) => [...cards.values()].filter((c) => c.external_ref === t || c.id === t).sort((a, b) => rank(a.status) - rank(b.status))[0] ?? null,
    listUndispatchedInProgress: () => [...cards.values()].filter((c) => c.status === 'in_progress' && c.archived_at == null && c.dispatched_at == null),
    markDispatched: (id) => { const c = cards.get(id); if (c) c.dispatched_at = 1 },
    sendDispatch: (c, instance, info) => {
      if (sendThrows) throw new Error('router down')
      sent.push({ card: c.id, instance, ...info })
    },
    reportUndelivered: (id, why) => { reported.push([id, why]) },
    log: { info: () => {}, warn: () => {} },
    now: () => clock,
  }
}

function addCard(id: string, ref: string | null, scope: string | null, over: Partial<FlowCard> = {}): FlowCard {
  const c: FlowCard = { id, status: 'in_progress', archived_at: null, dispatched_at: null, assignee: 'cpp-developer', project: 'p', external_ref: ref, scope, ...over }
  cards.set(id, c)
  return c
}

function makeTemplate(name: string): void {
  const dir = join(agentsBase, name)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ model: 'm', displayName: name, team: { role: 'member', reportsTo: 'lead' } }))
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n`)
}

beforeEach(() => {
  resetTicketEnvironmentFlow()
  base = mkdtempSync(join(tmpdir(), 'ticket-flow-'))
  agentsBase = join(base, 'agents')
  mkdirSync(agentsBase, { recursive: true })
  cards = new Map(); running = new Set(); comments = []; sent = []; reported = []; startFails = null; sendThrows = false; clock = 1_000_000
  git(base, 'init', '--bare', 'origin.git')
  git(base, 'clone', '-q', 'origin.git', 'repo')
  writeFileSync(join(base, 'repo', 'a.txt'), 'one\n')
  git(join(base, 'repo'), 'add', '.'); git(join(base, 'repo'), 'commit', '-qm', 'init'); git(join(base, 'repo'), 'push', '-q', 'origin', 'HEAD:develop')
  makeTemplate('cpp-developer')
})
afterEach(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ } })

describe('dispatchViaEnvironment', () => {
  it('sends the card to the instance (not to the template), then sets the once-only guard', async () => {
    const io = makeIO(makeRegistry())
    const card = addCard('c1', 'TVR-1', 'src/a')
    expect(await dispatchViaEnvironment(card, 'cpp-developer', io)).toBe('dispatched')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ card: 'c1', instance: 'cpp-developer-tvr-1', branch: 'feature/TVR-1', baseBranch: 'develop' })
    expect(existsSync(sent[0].workspace)).toBe(true)
    expect(card.dispatched_at).toBe(1)
    // the template itself was never started: the work runs in the instance
    expect(running.has('cpp-developer')).toBe(false)
    expect(running.has('cpp-developer-tvr-1')).toBe(true)
  })

  it('leaves everything that is not an isolating project, and an instance as the assignee, to today\'s path', async () => {
    const io = makeIO(makeRegistry())
    expect(await dispatchViaEnvironment(addCard('c1', 'TVR-1', 'x', { project: 'shared' }), 'cpp-developer', io)).toBe('shared')
    expect(await dispatchViaEnvironment(addCard('c2', 'ZZZ-1', 'x', { project: null }), 'cpp-developer', io)).toBe('shared')
    // an instance as the assignee
    const first = addCard('c3', 'TVR-3', 'x')
    await dispatchViaEnvironment(first, 'cpp-developer', io)
    const onInstance = addCard('c4', 'TVR-4', 'y', { assignee: 'cpp-developer-tvr-3' })
    expect(await dispatchViaEnvironment(onInstance, 'cpp-developer-tvr-3', io)).toBe('shared')
    expect(sent.map((s) => s.card)).toEqual(['c3'])
  })

  it('a card that has to wait is told why on the card, once, and is not marked as dispatched', async () => {
    const io = makeIO(makeRegistry())
    await dispatchViaEnvironment(addCard('c1', 'TVR-1', 'src/games'), 'cpp-developer', io)
    comments = []
    const waiting = addCard('c2', 'TVR-2', 'src/games/chess')
    expect(await dispatchViaEnvironment(waiting, 'cpp-developer', io)).toBe('queued')
    expect(await dispatchViaEnvironment(waiting, 'cpp-developer', io)).toBe('queued')
    expect(comments).toHaveLength(1)
    expect(comments[0][0]).toBe('c2')
    expect(comments[0][1]).toContain('TVR-1')
    expect(waiting.dispatched_at).toBeNull()
    expect(sent.map((s) => s.card)).toEqual(['c1'])
  })

  it('a failure is reported on the first try and again on the fifth, never in between', async () => {
    startFails = 'tmux is down'
    const io = makeIO(makeRegistry())
    const card = addCard('c1', 'TVR-1', 'src')
    for (let i = 1; i <= 6; i++) expect(await dispatchViaEnvironment(card, 'cpp-developer', io)).toBe('failed')
    expect(reported.map(([id]) => id)).toEqual(['c1', 'c1'])
    expect(reported[0][1]).toContain('tmux is down')
    expect(card.dispatched_at).toBeNull()
    expect(sent).toEqual([])
  })

  it('a router that fails after the environment is ready is a failure, and the retry reuses the environment', async () => {
    const io = makeIO(makeRegistry())
    const card = addCard('c1', 'TVR-1', 'src')
    sendThrows = true
    expect(await dispatchViaEnvironment(card, 'cpp-developer', io)).toBe('failed')
    expect(card.dispatched_at).toBeNull()
    expect(reported).toHaveLength(1)
    sendThrows = false
    expect(await dispatchViaEnvironment(card, 'cpp-developer', io)).toBe('dispatched')
    expect(sent).toHaveLength(1)
    expect(listAgentInstances(agentsBase)).toHaveLength(1)
  })

  it('the same card dispatched twice at once is prepared once: the second call is busy', async () => {
    const io = makeIO(makeRegistry())
    const card = addCard('c1', 'TVR-1', 'src')
    const [a, b] = await Promise.all([dispatchViaEnvironment(card, 'cpp-developer', io), dispatchViaEnvironment(card, 'cpp-developer', io)])
    expect([a, b].sort()).toEqual(['busy', 'dispatched'])
    expect(sent).toHaveLength(1)
  })

  it('isolatingProjectOf finds the project by the card, by the Jira key, and says nothing for a shared one', () => {
    const io = makeIO(makeRegistry())
    expect(isolatingProjectOf(addCard('c1', null, null, { project: 'p' }), io)?.name).toBe('p')
    expect(isolatingProjectOf(addCard('c2', 'TVR-9', null, { project: null }), io)?.name).toBe('p')
    expect(isolatingProjectOf(addCard('c3', null, null, { project: 'shared' }), io)).toBeNull()
  })
})

// Copilot findings on PR #7, each reproduced here before the fix.
describe('what the flow remembers about a card does not outlive its spell in progress', () => {
  it('a card that queued, left in_progress and came back queues for the same reason again: the second spell is told too', async () => {
    const io = makeIO(makeRegistry())
    await dispatchViaEnvironment(addCard('c1', 'TVR-1', 'src/games'), 'cpp-developer', io)
    const b = addCard('c2', 'TVR-2', 'src/games/chess')
    expect(await dispatchViaEnvironment(b, 'cpp-developer', io)).toBe('queued')
    expect(comments.filter(([id]) => id === 'c2')).toHaveLength(1)

    // B leaves in_progress without ever being dispatched, and a pass notices
    b.status = 'planned'
    await reconcileTicketEnvironments(io)
    // ... and comes back, waiting for the very same ticket
    b.status = 'in_progress'
    expect(await dispatchViaEnvironment(b, 'cpp-developer', io)).toBe('queued')
    expect(comments.filter(([id]) => id === 'c2')).toHaveLength(2)
  })

  it('a card that failed, left in_progress and came back is retried at once, not after the old delay', async () => {
    startFails = 'down'
    const io = makeIO(makeRegistry())
    const c = addCard('c1', 'TVR-1', 'src')
    await reconcileTicketEnvironments(io)                    // fails, retry in a minute
    expect(reported).toHaveLength(1)

    c.status = 'planned'
    await reconcileTicketEnvironments(io)                    // it left: what was remembered is dropped
    startFails = null
    c.status = 'in_progress'
    clock += 1_000                                           // far inside the old one-minute delay
    expect((await reconcileTicketEnvironments(io)).dispatched).toEqual(['c1'])
  })

  it('a card that failed and left is reported afresh when it fails again in a new spell', async () => {
    startFails = 'down'
    const io = makeIO(makeRegistry())
    const c = addCard('c1', 'TVR-1', 'src')
    await reconcileTicketEnvironments(io)
    expect(reported).toHaveLength(1)
    c.status = 'planned'
    await reconcileTicketEnvironments(io)
    c.status = 'in_progress'
    await reconcileTicketEnvironments(io)
    expect(reported).toHaveLength(2)
  })

  it('a card that is still in progress and still waiting keeps what was remembered (no new note, no early retry)', async () => {
    const io = makeIO(makeRegistry())
    await dispatchViaEnvironment(addCard('c1', 'TVR-1', 'src/games'), 'cpp-developer', io)
    const b = addCard('c2', 'TVR-2', 'src/games/chess')
    await dispatchViaEnvironment(b, 'cpp-developer', io)
    for (let i = 0; i < 5; i++) await reconcileTicketEnvironments(io)
    expect(comments.filter(([id]) => id === 'c2')).toHaveLength(1)
  })

  it('a card that is deleted while it waits is forgotten too', async () => {
    const io = makeIO(makeRegistry())
    await dispatchViaEnvironment(addCard('c1', 'TVR-1', 'src/games'), 'cpp-developer', io)
    const b = addCard('c2', 'TVR-2', 'src/games/chess')
    await dispatchViaEnvironment(b, 'cpp-developer', io)
    cards.delete('c2')
    await reconcileTicketEnvironments(io)
    cards.set('c2', { ...b, status: 'in_progress', dispatched_at: null })
    await dispatchViaEnvironment(cards.get('c2') as FlowCard, 'cpp-developer', io)
    expect(comments.filter(([id]) => id === 'c2')).toHaveLength(2)
  })
})

describe('the template a flow is given is the canonical agent id', () => {
  it('a display label is refused with a message that says so, reported on the card, and nothing is created', async () => {
    const io = makeIO(makeRegistry())
    const card = addCard('c1', 'TVR-1', 'src')
    expect(await dispatchViaEnvironment(card, 'Cpp Developer', io)).toBe('failed')
    expect(reported).toHaveLength(1)
    expect(reported[0][1]).toContain('invalid template name')
    expect(sent).toEqual([])
    expect(listAgentInstances(agentsBase)).toEqual([])
    expect(listWorkspaces(io.env.registry.projects[0])).toEqual([])
  })
})

describe('reconcileTicketEnvironments: releasing', () => {
  async function ready(io: FlowIO, id: string, ref: string, scope: string): Promise<FlowCard> {
    const c = addCard(id, ref, scope)
    expect(await dispatchViaEnvironment(c, 'cpp-developer', io)).toBe('dispatched')
    return c
  }

  it('releases the environment of a card that is done, planned, archived or gone; keeps the active ones', async () => {
    const io = makeIO(makeRegistry({ maxParallel: 6 }))
    const done = await ready(io, 'c1', 'TVR-1', 'a'); const planned = await ready(io, 'c2', 'TVR-2', 'b')
    const archived = await ready(io, 'c3', 'TVR-3', 'c'); const gone = await ready(io, 'c4', 'TVR-4', 'd')
    const waiting = await ready(io, 'c5', 'TVR-5', 'e'); const testing = await ready(io, 'c6', 'TVR-6', 'f')
    done.status = 'done'; planned.status = 'planned'; archived.archived_at = 1; cards.delete(gone.id)
    waiting.status = 'waiting'; testing.status = 'testing'

    const report = await reconcileTicketEnvironments(io)
    expect(report.released.sort()).toEqual(['TVR-1', 'TVR-2', 'TVR-3', 'TVR-4'])
    expect(report.errors).toEqual([])
    expect(listAgentInstances(agentsBase).map((i) => i.of.ticket).sort()).toEqual(['TVR-5', 'TVR-6'])
    expect(listWorkspaces(io.env.registry.projects[0]).map((m) => m.ticket).sort()).toEqual(['TVR-5', 'TVR-6'])
  })

  it('keeps a workspace with unsaved work, removes the instance, and says so', async () => {
    const io = makeIO(makeRegistry())
    const c = await ready(io, 'c1', 'TVR-1', 'a')
    writeFileSync(join(sent[0].workspace, 'wip.txt'), 'not committed\n')
    c.status = 'done'
    const report = await reconcileTicketEnvironments(io)
    expect(report.kept).toEqual(['TVR-1'])
    expect(existsSync(sent[0].workspace)).toBe(true)
    expect(listAgentInstances(agentsBase)).toEqual([])
    expect(comments.at(-1)?.[1]).toContain('nem töröltem')
    // the next pass finds nothing new to do for it: the workspace is still there and still reported only by the comment
    comments = []
    await reconcileTicketEnvironments(io)
    expect(existsSync(sent[0].workspace)).toBe(true)
  })

  it('does nothing when every card is still active', async () => {
    const io = makeIO(makeRegistry())
    await ready(io, 'c1', 'TVR-1', 'a')
    expect(await reconcileTicketEnvironments(io)).toEqual({ released: [], kept: [], dispatched: [], errors: [] })
  })

  it('a session that cannot be stopped is an error in the report, and the others are still released', async () => {
    const io = makeIO(makeRegistry())
    const a = await ready(io, 'c1', 'TVR-1', 'a'); const b = await ready(io, 'c2', 'TVR-2', 'b')
    a.status = 'done'; b.status = 'done'
    const stop = io.env.stopAgent
    io.env.stopAgent = async (n) => (n.endsWith('tvr-1') ? { ok: false, error: 'busy' } : stop(n))
    const report = await reconcileTicketEnvironments(io)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toContain('TVR-1')
    expect(report.released).toEqual(['TVR-2'])
  })

  it('leaves a shared project alone', async () => {
    const io = makeIO(makeRegistry())
    addCard('c9', 'ZZZ-1', 'x', { project: 'shared', status: 'done' })
    expect(await reconcileTicketEnvironments(io)).toEqual({ released: [], kept: [], dispatched: [], errors: [] })
  })
})

describe('reconcileTicketEnvironments: retrying what waited', () => {
  it('a card that had to queue is dispatched as soon as the ticket in its way is done', async () => {
    const io = makeIO(makeRegistry())
    const a = addCard('c1', 'TVR-1', 'src/games')
    await dispatchViaEnvironment(a, 'cpp-developer', io)
    const b = addCard('c2', 'TVR-2', 'src/games/chess')
    expect(await dispatchViaEnvironment(b, 'cpp-developer', io)).toBe('queued')

    // nothing changes while A is active: B stays queued, and no second note is written
    comments = []
    expect((await reconcileTicketEnvironments(io)).dispatched).toEqual([])
    expect(comments).toEqual([])

    a.status = 'done'
    const report = await reconcileTicketEnvironments(io)
    expect(report.released).toEqual(['TVR-1'])
    expect(report.dispatched).toEqual(['c2'])
    expect(sent.map((s) => s.card)).toEqual(['c1', 'c2'])
    expect(b.dispatched_at).toBe(1)
  })

  it('a capacity queue clears the same way', async () => {
    const io = makeIO(makeRegistry({ maxParallel: 1 }))
    const a = addCard('c1', 'TVR-1', 'docs'); await dispatchViaEnvironment(a, 'cpp-developer', io)
    const b = addCard('c2', 'TVR-2', 'src'); expect(await dispatchViaEnvironment(b, 'cpp-developer', io)).toBe('queued')
    a.status = 'done'
    expect((await reconcileTicketEnvironments(io)).dispatched).toEqual(['c2'])
  })

  it('a failed card waits out its delay, which grows, and is then tried again', async () => {
    startFails = 'down'
    const io = makeIO(makeRegistry())
    addCard('c1', 'TVR-1', 'src')
    await reconcileTicketEnvironments(io)                       // first try: fails, retry in 1 minute
    expect(reported).toHaveLength(1)
    startFails = null
    clock += 30_000
    expect((await reconcileTicketEnvironments(io)).dispatched).toEqual([])   // too early
    clock += 31_000
    expect((await reconcileTicketEnvironments(io)).dispatched).toEqual(['c1'])
  })

  it('does not try a card that names no agent, a shared card, or one that is already dispatched', async () => {
    const io = makeIO(makeRegistry())
    addCard('c1', 'TVR-1', 'a', { assignee: 'nobody' })
    addCard('c2', 'ZZZ-1', 'b', { project: 'shared' })
    addCard('c3', 'TVR-3', 'c', { dispatched_at: 5 })
    expect(await reconcileTicketEnvironments(io)).toEqual({ released: [], kept: [], dispatched: [], errors: [] })
    expect(sent).toEqual([])
  })
})
