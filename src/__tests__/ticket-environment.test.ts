// The whole ticket-environment flow against real git and a real agents directory, with the session start and stop
// faked: prepare (decide, workspace, instance, start, with rollback) and release (stop, archive, delete, keep
// unpushed work).
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectRegistry } from '../projects.js'
import { listWorkspaces } from '../web/workspace.js'
import { listAgentInstances } from '../web/agent-instance.js'
import {
  prepareTicketEnvironment, releaseTicketEnvironment, hasTicketEnvironment, instanceNameFor, ticketKeyOf,
  type EnvironmentDeps, type TicketCard,
} from '../web/ticket-environment.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] } })
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}

let base: string
let agentsBase: string
let running: Set<string>
let started: string[]
let stopped: string[]
let comments: Array<[string, string]>
let scopes: Map<string, string | null>

function makeRegistry(extra: Record<string, unknown> = {}): ProjectRegistry {
  return normalizeProjectRegistry({
    projects: {
      p: {
        repoPath: join(base, 'repo'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 2, jiraKeys: ['TVR'], ...extra,
      },
      shared: { repoPath: join(base, 'other'), mode: 'shared' },
    },
  })
}

function makeDeps(registry: ProjectRegistry, over: Partial<EnvironmentDeps> = {}): EnvironmentDeps {
  return {
    registry,
    agentsBase,
    reservedIds: ['marveen'],
    scopeOfTicket: (t) => scopes.get(t) ?? null,
    startAgent: async (n) => { started.push(n); running.add(n); return { ok: true } },
    stopAgent: async (n) => { stopped.push(n); running.delete(n); return { ok: true } },
    isRunning: (n) => running.has(n),
    comment: (id, text) => { comments.push([id, text]) },
    ...over,
  }
}

function card(id: string, ref: string | null, scope: string | null, project: string | null = 'p'): TicketCard {
  if (ref) scopes.set(ref, scope)
  return { id, project, external_ref: ref, scope }
}

function makeTemplate(name: string): void {
  const dir = join(agentsBase, name)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ model: 'm', displayName: name, team: { role: 'member', reportsTo: 'lead' } }))
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n`)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ticket-env-'))
  agentsBase = join(base, 'agents')
  mkdirSync(agentsBase, { recursive: true })
  running = new Set(); started = []; stopped = []; comments = []; scopes = new Map()
  git(base, 'init', '--bare', 'origin.git')
  git(base, 'clone', '-q', 'origin.git', 'repo')
  writeFileSync(join(base, 'repo', 'a.txt'), 'one\n')
  git(join(base, 'repo'), 'add', '.'); git(join(base, 'repo'), 'commit', '-qm', 'init'); git(join(base, 'repo'), 'push', '-q', 'origin', 'HEAD:develop')
  makeTemplate('cpp-developer')
})
afterEach(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ } })

describe('ticketKeyOf', () => {
  it('prefers the external reference, falls back to the card id, and is null for neither', () => {
    expect(ticketKeyOf({ id: 'abc12345', project: null, external_ref: 'TVR-1', scope: null })).toBe('TVR-1')
    expect(ticketKeyOf({ id: 'abc12345', project: null, external_ref: null, scope: null })).toBe('abc12345')
    expect(ticketKeyOf({ id: 'abc12345', project: null, external_ref: '../x', scope: null })).toBe('abc12345')
    expect(ticketKeyOf({ id: '../x', project: null, external_ref: null, scope: null })).toBeNull()
  })
})

describe('prepare: the cases that stay on today\'s path', () => {
  it('no project, an unknown project, a shared project and a template that cannot have instances are all `shared`, with no side effects', async () => {
    const deps = makeDeps(makeRegistry())
    // no project on the card and a Jira key no project owns
    expect(await prepareTicketEnvironment(card('c1', 'ZZZ-1', 'src', null), 'cpp-developer', deps)).toEqual({ kind: 'shared' })
    expect(await prepareTicketEnvironment(card('c1', 'TVR-1', 'src', 'unknown'), 'cpp-developer', deps)).toEqual({ kind: 'shared' })
    expect(await prepareTicketEnvironment(card('c1', 'TVR-1', 'src', 'shared'), 'cpp-developer', deps)).toEqual({ kind: 'shared' })
    expect(await prepareTicketEnvironment(card('c1', 'TVR-1', 'src'), 'marveen', deps)).toEqual({ kind: 'shared' })
    expect(started).toEqual([])
    expect(existsSync(join(base, 'ws'))).toBe(false)
    expect(listAgentInstances(agentsBase)).toEqual([])
  })

  it('a card whose project is found by its Jira key prefix gets an environment', async () => {
    const deps = makeDeps(makeRegistry())
    const r = await prepareTicketEnvironment(card('c1', 'TVR-7', 'src', null), 'cpp-developer', deps)
    expect(r).toMatchObject({ kind: 'ready', project: 'p' })
  })
})

describe('prepare: a new environment', () => {
  it('creates the workspace, the instance, starts it and says so on the card', async () => {
    const deps = makeDeps(makeRegistry())
    const r = await prepareTicketEnvironment(card('c1', 'TVR-1', 'src/a'), 'cpp-developer', deps)
    expect(r).toMatchObject({ kind: 'ready', instance: 'cpp-developer-tvr-1', branch: 'feature/TVR-1', baseBranch: 'develop', created: true })
    if (r.kind !== 'ready') return

    expect(readFileSync(join(r.workspace, 'a.txt'), 'utf-8')).toBe('one\n')
    expect(git(r.workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/TVR-1')
    const md = readFileSync(join(agentsBase, r.instance, 'CLAUDE.md'), 'utf-8')
    expect(md).toContain(`git -C ${r.workspace}`)
    expect(started).toEqual(['cpp-developer-tvr-1'])
    expect(comments).toHaveLength(1)
    expect(comments[0][1]).toContain(r.workspace)
    expect(hasTicketEnvironment(card('c1', 'TVR-1', 'src/a'), deps)).toBe(true)
    expect(instanceNameFor(card('c1', 'TVR-1', null), 'cpp-developer', deps)).toBe('cpp-developer-tvr-1')
  })

  it('is idempotent: the same card again gets the same environment, with no second start and no second comment', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src/a')
    await prepareTicketEnvironment(c, 'cpp-developer', deps)
    const again = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    expect(again).toMatchObject({ kind: 'ready', created: false })
    expect(started).toHaveLength(1)
    expect(comments).toHaveLength(1)
  })

  it('starts the instance again when its session is down, without making anything new', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src/a')
    await prepareTicketEnvironment(c, 'cpp-developer', deps)
    running.clear()
    const again = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    expect(again).toMatchObject({ kind: 'ready', created: false })
    expect(started).toEqual(['cpp-developer-tvr-1', 'cpp-developer-tvr-1'])
    expect(comments).toHaveLength(1)
  })

  it('a card with no external reference uses its card id as the ticket', async () => {
    const deps = makeDeps(makeRegistry())
    const r = await prepareTicketEnvironment({ id: 'ab12cd34', project: 'p', external_ref: null, scope: 'src' }, 'cpp-developer', deps)
    expect(r).toMatchObject({ kind: 'ready', branch: 'feature/ab12cd34', instance: 'cpp-developer-ab12cd34' })
  })
})

describe('prepare: what the decision tree sends to the queue', () => {
  it('disjoint scopes run in parallel, each in its own workspace and instance', async () => {
    const deps = makeDeps(makeRegistry())
    const a = await prepareTicketEnvironment(card('c1', 'TVR-1', 'src/games'), 'cpp-developer', deps)
    const b = await prepareTicketEnvironment(card('c2', 'TVR-2', 'docs'), 'cpp-developer', deps)
    expect(a.kind).toBe('ready'); expect(b.kind).toBe('ready')
    expect(a.kind === 'ready' && b.kind === 'ready' && a.workspace !== b.workspace && a.instance !== b.instance).toBe(true)
    expect(started).toEqual(['cpp-developer-tvr-1', 'cpp-developer-tvr-2'])
  })

  it('an overlapping ticket queues and nothing is created for it', async () => {
    const deps = makeDeps(makeRegistry())
    await prepareTicketEnvironment(card('c1', 'TVR-1', 'src/games'), 'cpp-developer', deps)
    const r = await prepareTicketEnvironment(card('c2', 'TVR-2', 'src/games/chess'), 'cpp-developer', deps)
    expect(r).toEqual({ kind: 'queued', reason: 'overlap', waitingFor: ['TVR-1'], project: 'p' })
    expect(started).toHaveLength(1)
    expect(listAgentInstances(agentsBase).map((i) => i.of.ticket)).toEqual(['TVR-1'])
    expect(listWorkspaces(deps.registry.projects[0]).map((m) => m.ticket)).toEqual(['TVR-1'])
  })

  it('an undeclared scope counts as overlap', async () => {
    const deps = makeDeps(makeRegistry())
    await prepareTicketEnvironment(card('c1', 'TVR-1', 'src/games'), 'cpp-developer', deps)
    expect(await prepareTicketEnvironment(card('c2', 'TVR-2', null), 'cpp-developer', deps)).toMatchObject({ kind: 'queued', reason: 'overlap' })
  })

  it('at the project\'s limit even a disjoint ticket queues, for capacity', async () => {
    const deps = makeDeps(makeRegistry())
    await prepareTicketEnvironment(card('c1', 'TVR-1', 'a'), 'cpp-developer', deps)
    await prepareTicketEnvironment(card('c2', 'TVR-2', 'b'), 'cpp-developer', deps)
    const r = await prepareTicketEnvironment(card('c3', 'TVR-3', 'c'), 'cpp-developer', deps)
    expect(r).toEqual({ kind: 'queued', reason: 'capacity', waitingFor: ['TVR-1', 'TVR-2'], project: 'p' })
  })

  it('with onOverlap "stack" the second ticket is built on the first one\'s branch and carries its work', async () => {
    const deps = makeDeps(makeRegistry({ onOverlap: 'stack', maxParallel: 5 }))
    const a = await prepareTicketEnvironment(card('c1', 'TVR-1', 'src'), 'cpp-developer', deps)
    if (a.kind !== 'ready') throw new Error('first ticket not ready')
    writeFileSync(join(a.workspace, 'first.txt'), 'from the first\n')
    git(a.workspace, 'add', '.'); git(a.workspace, 'commit', '-qm', 'first ticket')

    const b = await prepareTicketEnvironment(card('c2', 'TVR-2', 'src/menu'), 'cpp-developer', deps)
    expect(b).toMatchObject({ kind: 'ready', baseBranch: 'feature/TVR-1', branch: 'feature/TVR-2' })
    if (b.kind !== 'ready') return
    expect(readFileSync(join(b.workspace, 'first.txt'), 'utf-8')).toBe('from the first\n')

    // the existing stacked ticket keeps its base when prepared again
    expect(await prepareTicketEnvironment(card('c2', 'TVR-2', 'src/menu'), 'cpp-developer', deps)).toMatchObject({ kind: 'ready', created: false, baseBranch: 'feature/TVR-1' })
  })

  it('stacking in a clone (submodule) project is not possible, so the ticket queues', async () => {
    const deps = makeDeps(makeRegistry({ onOverlap: 'stack', repoKind: 'submodule', maxParallel: 5 }))
    // the "submodule" here is an ordinary repo with an origin, which is all the clone method needs
    await prepareTicketEnvironment(card('c1', 'TVR-1', 'src'), 'cpp-developer', deps)
    const r = await prepareTicketEnvironment(card('c2', 'TVR-2', 'src'), 'cpp-developer', deps)
    expect(r).toEqual({ kind: 'queued', reason: 'stacking-unsupported', waitingFor: ['TVR-1'], project: 'p' })
  })
})

describe('prepare: a failed step undoes the ones before it', () => {
  it('a session that does not start leaves no instance, no workspace, no marker and no branch', async () => {
    const deps = makeDeps(makeRegistry(), { startAgent: async () => ({ ok: false, error: 'tmux is not available' }) })
    const r = await prepareTicketEnvironment(card('c1', 'TVR-1', 'src'), 'cpp-developer', deps)
    expect(r).toEqual({ kind: 'failed', error: 'start: tmux is not available' })
    expect(listAgentInstances(agentsBase)).toEqual([])
    expect(listWorkspaces(deps.registry.projects[0])).toEqual([])
    expect(existsSync(join(base, 'ws', 'p', 'TVR-1'))).toBe(false)
    expect(git(join(base, 'repo'), 'branch', '--list', 'feature/TVR-1').trim()).toBe('')
    expect(comments).toEqual([])
  })

  it('a missing template leaves no workspace behind', async () => {
    const deps = makeDeps(makeRegistry())
    const r = await prepareTicketEnvironment(card('c1', 'TVR-1', 'src'), 'no-such-agent', deps)
    expect(r.kind).toBe('failed')
    expect(r.kind === 'failed' && r.error).toContain('instance:')
    expect(listWorkspaces(deps.registry.projects[0])).toEqual([])
    expect(existsSync(join(base, 'ws', 'p', 'TVR-1'))).toBe(false)
  })

  it('a failed restart of an environment that already existed keeps that environment', async () => {
    const c = card('c1', 'TVR-1', 'src')
    const first = makeDeps(makeRegistry())
    await prepareTicketEnvironment(c, 'cpp-developer', first)
    running.clear()
    const failing = makeDeps(makeRegistry(), { startAgent: async () => ({ ok: false, error: 'down' }) })
    const r = await prepareTicketEnvironment(c, 'cpp-developer', failing)
    expect(r.kind).toBe('failed')
    expect(listAgentInstances(agentsBase)).toHaveLength(1)
    expect(listWorkspaces(failing.registry.projects[0])).toHaveLength(1)
  })

  it('an invalid ticket key (no usable reference or id) is a failure, not a crash', async () => {
    const deps = makeDeps(makeRegistry())
    const r = await prepareTicketEnvironment({ id: '../x', project: 'p', external_ref: null, scope: 'src' }, 'cpp-developer', deps)
    expect(r.kind).toBe('failed')
  })
})

describe('release', () => {
  it('stops the instance, archives its memory into the template, deletes it and the clean workspace', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(agentsBase, r.instance, 'memory', 'learned.md'), 'a build quirk\n')

    const rel = await releaseTicketEnvironment(c, deps)
    expect(rel).toEqual({ ok: true, released: true, keptWorkspace: null, keptNew: false })
    expect(stopped).toEqual([r.instance])
    expect(existsSync(join(agentsBase, r.instance))).toBe(false)
    expect(existsSync(r.workspace)).toBe(false)
    expect(readFileSync(join(agentsBase, 'cpp-developer', 'memory', 'tickets', 'TVR-1', 'learned.md'), 'utf-8')).toBe('a build quirk\n')
    expect(hasTicketEnvironment(c, deps)).toBe(false)
    // the ticket made no commit, so its branch held nothing and is gone with the environment
    expect(git(join(base, 'repo'), 'branch', '--list', 'feature/TVR-1').trim()).toBe('')
  })

  it('keeps the branch when it holds a commit of its own, even a pushed one', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(r.workspace, 'work.txt'), 'x\n')
    git(r.workspace, 'add', '.'); git(r.workspace, 'commit', '-qm', 'work'); git(r.workspace, 'push', '-q', 'origin', 'feature/TVR-1')
    expect(await releaseTicketEnvironment(c, deps)).toEqual({ ok: true, released: true, keptWorkspace: null, keptNew: false })
    expect(existsSync(r.workspace)).toBe(false)
    expect(git(join(base, 'repo'), 'branch', '--list', 'feature/TVR-1').trim()).not.toBe('')
  })

  it('a ticket that was released can be prepared again (the empty branch it left does not block it)', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    await prepareTicketEnvironment(c, 'cpp-developer', deps)
    await releaseTicketEnvironment(c, deps)
    expect(await prepareTicketEnvironment(c, 'cpp-developer', deps)).toMatchObject({ kind: 'ready', created: true })
  })

  it('keeps a workspace that holds unsaved work and says so on the card, but still removes the instance', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(r.workspace, 'wip.txt'), 'not committed\n')

    const rel = await releaseTicketEnvironment(c, deps)
    expect(rel).toEqual({ ok: true, released: true, keptWorkspace: r.workspace, keptNew: true })
    expect(existsSync(r.workspace)).toBe(true)
    expect(existsSync(join(agentsBase, r.instance))).toBe(false)
    expect(comments.at(-1)?.[1]).toContain('nem töröltem')
    expect(comments.at(-1)?.[1]).toContain(r.workspace)
  })

  it('a workspace that stays kept is not announced again: no second comment, nothing released, not new', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(r.workspace, 'wip.txt'), 'not committed\n')
    await releaseTicketEnvironment(c, deps)
    const told = comments.length
    expect(await releaseTicketEnvironment(c, deps)).toEqual({ ok: true, released: false, keptWorkspace: r.workspace, keptNew: false })
    expect(comments.length).toBe(told)
    // once the work is saved and the workspace goes, a later keep of the same card is announced afresh
    rmSync(join(r.workspace, 'wip.txt'))
    expect(await releaseTicketEnvironment(c, deps)).toEqual({ ok: true, released: true, keptWorkspace: null, keptNew: false })
  })

  it('keeps a workspace with commits no remote has seen', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(r.workspace, 'work.txt'), 'x\n')
    git(r.workspace, 'add', '.'); git(r.workspace, 'commit', '-qm', 'work')
    expect(await releaseTicketEnvironment(c, deps)).toMatchObject({ ok: true, keptWorkspace: r.workspace })
    git(r.workspace, 'push', '-q', 'origin', 'feature/TVR-1')
    // once pushed, a second release (instance already gone, workspace still there) removes it
    expect(await releaseTicketEnvironment(c, deps)).toEqual({ ok: true, released: true, keptWorkspace: null, keptNew: false })
    expect(existsSync(r.workspace)).toBe(false)
  })

  it('a session that cannot be stopped removes nothing', async () => {
    const deps = makeDeps(makeRegistry(), { stopAgent: async () => ({ ok: false, error: 'busy' }) })
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    const rel = await releaseTicketEnvironment(c, deps)
    expect(rel.ok).toBe(false)
    expect(existsSync(join(agentsBase, r.instance))).toBe(true)
    expect(existsSync(r.workspace)).toBe(true)
  })

  it('a memory that cannot be archived keeps the instance (nothing is deleted with its only copy)', async () => {
    const deps = makeDeps(makeRegistry())
    const c = card('c1', 'TVR-1', 'src')
    const r = await prepareTicketEnvironment(c, 'cpp-developer', deps)
    if (r.kind !== 'ready') throw new Error('not ready')
    writeFileSync(join(agentsBase, r.instance, 'memory', 'learned.md'), 'x\n')
    rmSync(join(agentsBase, 'cpp-developer'), { recursive: true, force: true })
    const rel = await releaseTicketEnvironment(c, deps)
    expect(rel.ok).toBe(false)
    expect(existsSync(join(agentsBase, r.instance, 'memory', 'learned.md'))).toBe(true)
  })

  it('a card with no environment, or in a project that does not isolate, releases nothing', async () => {
    const deps = makeDeps(makeRegistry())
    expect(await releaseTicketEnvironment(card('c9', 'TVR-9', 'x'), deps)).toEqual({ ok: true, released: false, keptWorkspace: null, keptNew: false })
    expect(await releaseTicketEnvironment(card('c9', 'TVR-9', 'x', 'shared'), deps)).toEqual({ ok: true, released: false, keptWorkspace: null, keptNew: false })
    expect(await releaseTicketEnvironment(card('c9', 'TVR-9', 'x', null), deps)).toEqual({ ok: true, released: false, keptWorkspace: null, keptNew: false })
    expect(stopped).toEqual([])
  })

  it('releasing frees the slot: a ticket that had to queue can be prepared afterwards', async () => {
    const deps = makeDeps(makeRegistry({ maxParallel: 1 }))
    const a = card('c1', 'TVR-1', 'a'); const b = card('c2', 'TVR-2', 'b')
    await prepareTicketEnvironment(a, 'cpp-developer', deps)
    expect(await prepareTicketEnvironment(b, 'cpp-developer', deps)).toMatchObject({ kind: 'queued', reason: 'capacity' })
    await releaseTicketEnvironment(a, deps)
    expect(await prepareTicketEnvironment(b, 'cpp-developer', deps)).toMatchObject({ kind: 'ready' })
  })
})
