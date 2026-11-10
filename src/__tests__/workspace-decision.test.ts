import { describe, it, expect } from 'vitest'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import { decideWorkspace, normalizeScope, scopesOverlap, type ActiveTicket } from '../workspace-decision.js'

function project(extra: Record<string, unknown> = {}): ProjectConfig {
  const r = normalizeProjectRegistry({ projects: { p: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: '/ws', maxParallel: 3, ...extra } } })
  return r.projects[0]
}
// Each call is one second newer than the one before, so a list built left to right is oldest first.
let tick = 0
const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString()
const at = (ticket: string, scope: string[] | null = null, over: Partial<ActiveTicket> = {}): ActiveTicket =>
  ({ ticket, scope, branch: `feature/${ticket}`, baseBranch: 'develop', createdAt: stamp(), ...over })

describe('normalizeScope', () => {
  it('cleans prefixes and drops anything that is not repo-relative', () => {
    expect(normalizeScope(['src/games/', './src/menu', 'src\\aux', ' src/games '])).toEqual(['src/games', 'src/menu', 'src/aux'])
    expect(normalizeScope(['/etc', '../x', 'a/../b', '', 3, null])).toBeNull()
    expect(normalizeScope([])).toBeNull()
    expect(normalizeScope('src')).toBeNull()
    expect(normalizeScope(undefined)).toBeNull()
  })
})

describe('scopesOverlap', () => {
  it('disjoint declared scopes do not overlap, on path boundaries', () => {
    expect(scopesOverlap(['src/games'], ['src/menu'])).toBe(false)
    expect(scopesOverlap(['src/games'], ['src/games-extra'])).toBe(false)
  })
  it('a parent and a child overlap, in both directions, and equal prefixes overlap', () => {
    expect(scopesOverlap(['src'], ['src/games/chess'])).toBe(true)
    expect(scopesOverlap(['src/games/chess'], ['src'])).toBe(true)
    expect(scopesOverlap(['src/a'], ['src/a'])).toBe(true)
  })
  it('one overlapping prefix among several is enough', () => {
    expect(scopesOverlap(['docs', 'src/menu'], ['src/games', 'src/menu/View.cpp'])).toBe(true)
  })
  it('unknown on either side counts as overlap: the safe side is never parallel', () => {
    expect(scopesOverlap(null, ['src'])).toBe(true)
    expect(scopesOverlap(['src'], null)).toBe(true)
    expect(scopesOverlap([], ['src'])).toBe(true)
    expect(scopesOverlap(null, null)).toBe(true)
  })
})

describe('decideWorkspace', () => {
  it('1. a project that does not isolate stays on today\'s shared path, whatever else is going on', () => {
    const shared = normalizeProjectRegistry({ projects: { p: { repoPath: '/r/app' } } }).projects[0]
    expect(decideWorkspace({ project: shared, ticket: 'T-1', scope: null, active: [at('T-2')] })).toEqual({ action: 'shared' })
    const noRoot = normalizeProjectRegistry({ projects: { p: { repoPath: '/r/app', mode: 'worktree' } } }).projects[0]
    expect(decideWorkspace({ project: noRoot, ticket: 'T-1', scope: null, active: [] })).toEqual({ action: 'shared' })
  })

  it('2. a ticket that already holds a workspace gets that one again, before any capacity or overlap check', () => {
    const p = project({ maxParallel: 1 })
    expect(decideWorkspace({ project: p, ticket: 'T-1', scope: null, active: [at('T-1')] })).toEqual({ action: 'existing' })
  })

  it('3. at maxParallel the ticket queues for capacity, naming who holds the slots', () => {
    const p = project({ maxParallel: 2 })
    const d = decideWorkspace({ project: p, ticket: 'T-3', scope: ['a'], active: [at('T-1', ['b']), at('T-2', ['c'])] })
    expect(d).toEqual({ action: 'queued', reason: 'capacity', waitingFor: ['T-1', 'T-2'] })
  })

  it('4. nobody else active: a new workspace off the base branch', () => {
    expect(decideWorkspace({ project: project({ baseBranch: 'main' }), ticket: 'T-1', scope: null, active: [] }))
      .toEqual({ action: 'new', baseBranch: 'main' })
  })

  it('5. provably disjoint from every active ticket: parallel, off the base branch', () => {
    const d = decideWorkspace({ project: project(), ticket: 'T-3', scope: ['src/menu'], active: [at('T-1', ['src/games']), at('T-2', ['docs'])] })
    expect(d).toEqual({ action: 'new', baseBranch: 'develop' })
  })

  it('6a. an unknown scope on the new ticket is treated as overlap and, by default, waits', () => {
    const d = decideWorkspace({ project: project(), ticket: 'T-2', scope: null, active: [at('T-1', ['src/games'])] })
    expect(d).toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['T-1'] })
  })

  it('6b. an unknown scope on an active ticket is overlap too', () => {
    const d = decideWorkspace({ project: project(), ticket: 'T-2', scope: ['docs'], active: [at('T-1', null)] })
    expect(d).toMatchObject({ action: 'queued', reason: 'overlap' })
  })

  it('6c. only the conflicting tickets are waited for, not the disjoint ones', () => {
    const d = decideWorkspace({ project: project(), ticket: 'T-3', scope: ['src/games'], active: [at('T-1', ['docs']), at('T-2', ['src/games/chess'])] })
    expect(d).toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['T-2'] })
  })

  it('6d. with onOverlap "stack" a single conflicting ticket is built on directly', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const d = decideWorkspace({ project: p, ticket: 'T-3', scope: ['src'], active: [at('T-1', ['src/a']), at('T-2', ['docs'])] })
    expect(d).toEqual({ action: 'stacked', onTicket: 'T-1', baseBranch: 'feature/T-1' })
  })

  it('6e. with a chain of conflicting tickets (each cut from the one before) it stacks on the newest', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const a = at('A', ['src/a'])
    const b = at('B', ['src/b'], { baseBranch: 'feature/A' })
    const c = at('C', ['src/c'], { baseBranch: 'feature/B' })
    expect(decideWorkspace({ project: p, ticket: 'D', scope: ['src'], active: [a, b, c] }))
      .toEqual({ action: 'stacked', onTicket: 'C', baseBranch: 'feature/C' })
  })

  it('6f. the newest is decided by createdAt, never by the order the caller listed the tickets in', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const a = at('A', ['src/a'])
    const b = at('B', ['src/b'], { baseBranch: 'feature/A' })
    const c = at('C', ['src/c'], { baseBranch: 'feature/B' })
    const expected = { action: 'stacked', onTicket: 'C', baseBranch: 'feature/C' }
    for (const order of [[a, b, c], [c, b, a], [b, c, a], [c, a, b]]) {
      expect(decideWorkspace({ project: p, ticket: 'D', scope: ['src'], active: order })).toEqual(expected)
    }
  })

  it('6g. independent conflicting tickets cannot both be contained in one branch: it waits instead of stacking', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const a = at('A', ['src/a'])
    const b = at('B', ['src/b']) // cut from develop, not from A
    const d = decideWorkspace({ project: p, ticket: 'C', scope: ['src'], active: [a, b] })
    expect(d).toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['A', 'B'] })
  })

  it('6h. a chain that is broken (the newest is not stacked on one of the conflicting tickets) waits', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const a = at('A', ['src/a'])
    const b = at('B', ['src/b'])
    const c = at('C', ['src/c'], { baseBranch: 'feature/B' }) // contains B but not A
    expect(decideWorkspace({ project: p, ticket: 'D', scope: ['src'], active: [a, b, c] }))
      .toMatchObject({ action: 'queued', reason: 'overlap' })
  })

  it('names the waiting tickets oldest first, whatever the input order', () => {
    const a = at('A', ['src']); const b = at('B', ['src'])
    expect(decideWorkspace({ project: project(), ticket: 'C', scope: ['src'], active: [b, a] }))
      .toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['A', 'B'] })
    expect(decideWorkspace({ project: project({ maxParallel: 2 }), ticket: 'C', scope: ['x'], active: [b, a] }))
      .toEqual({ action: 'queued', reason: 'capacity', waitingFor: ['A', 'B'] })
  })

  it('a ticket whose branch is its own base cannot loop the chain walk', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 5 })
    const a = at('A', ['src'], { baseBranch: 'feature/A' })
    expect(decideWorkspace({ project: p, ticket: 'B', scope: ['src'], active: [a] })).toMatchObject({ action: 'stacked', onTicket: 'A' })
  })

  it('capacity is checked before overlap: a full project queues even when stacking would be allowed', () => {
    const p = project({ onOverlap: 'stack', maxParallel: 1 })
    expect(decideWorkspace({ project: p, ticket: 'T-2', scope: ['src'], active: [at('T-1', ['src'])] }))
      .toMatchObject({ action: 'queued', reason: 'capacity' })
  })

  it('does not mutate its input', () => {
    const active = [at('T-1', ['src'])]
    const snapshot = JSON.stringify(active)
    decideWorkspace({ project: project(), ticket: 'T-2', scope: ['src'], active })
    expect(JSON.stringify(active)).toBe(snapshot)
  })
})

describe('registry: onOverlap', () => {
  it('defaults to wait, accepts stack, and reports an unknown value', () => {
    const r = normalizeProjectRegistry({ projects: { a: { repoPath: '/a' }, b: { repoPath: '/b', onOverlap: 'stack' }, c: { repoPath: '/c', onOverlap: 'nope' } } })
    expect(r.projects.map((p) => p.onOverlap)).toEqual(['wait', 'stack', 'wait'])
    expect(r.problems.some((l) => l.includes('"c"') && l.includes('onOverlap'))).toBe(true)
  })
})
