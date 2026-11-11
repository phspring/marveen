// Copilot finding on PR #5: a scope entry of "." was accepted but never overlapped anything, so a ticket that
// declared the whole repo looked disjoint from every other ticket. "." is the repo root and overlaps everything;
// paths written with "." segments or doubled slashes are the same path as their clean form.
import { describe, it, expect } from 'vitest'
import { normalizeProjectRegistry } from '../projects.js'
import { normalizeScope, scopesOverlap, decideWorkspace, type ActiveTicket } from '../workspace-decision.js'
import { normalizeScopeField, parseScopeText } from '../kanban-ticket-fields.js'

describe('normalizeScope: the repo root and equivalent spellings of one path', () => {
  it('"." and its spellings are the repo root', () => {
    for (const v of ['.', './', '././', ' . ', './/']) expect(normalizeScope([v]), JSON.stringify(v)).toEqual(['.'])
  })

  it('"." segments and doubled slashes do not make a different path', () => {
    expect(normalizeScope(['src/./games', 'src//games/', './src/games', 'src/games/.'])).toEqual(['src/games'])
    expect(normalizeScope(['./src', 'src/'])).toEqual(['src'])
  })

  it('escaping paths stay invalid, however they are spelled', () => {
    for (const v of ['..', './..', 'src/../x', 'src/./../x', '../', '/', '/abs', '//double']) {
      expect(normalizeScope([v]), JSON.stringify(v)).toBeNull()
    }
  })

  it('the root next to another entry is kept as the root', () => {
    expect(normalizeScope(['src', '.'])).toEqual(['src', '.'])
  })
})

describe('scopesOverlap with the repo root', () => {
  it('the root overlaps everything, in both directions', () => {
    expect(scopesOverlap(['.'], ['src'])).toBe(true)
    expect(scopesOverlap(['src'], ['.'])).toBe(true)
    expect(scopesOverlap(['./'], ['docs/a/b'])).toBe(true)
    expect(scopesOverlap(['.'], ['.'])).toBe(true)
  })

  it('differently spelled equal paths overlap', () => {
    expect(scopesOverlap(['src/./games'], ['src/games/chess'])).toBe(true)
    expect(scopesOverlap(['src//games'], ['./src/games'])).toBe(true)
  })

  it('disjoint paths still do not overlap', () => {
    expect(scopesOverlap(['src/./games'], ['src/menu'])).toBe(false)
  })
})

describe('decideWorkspace with a root scope', () => {
  const project = normalizeProjectRegistry({ projects: { p: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: '/ws', maxParallel: 5 } } }).projects[0]
  const active = (ticket: string, scope: string[] | null): ActiveTicket =>
    ({ ticket, scope, branch: `feature/${ticket}`, baseBranch: 'develop', createdAt: '2026-01-01T00:00:00.000Z' })

  it('a ticket declaring the whole repo waits for a ticket on a sub-path', () => {
    expect(decideWorkspace({ project, ticket: 'B', scope: ['.'], active: [active('A', ['src'])] }))
      .toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['A'] })
  })

  it('and a sub-path ticket waits for one that declared the whole repo', () => {
    expect(decideWorkspace({ project, ticket: 'B', scope: ['src'], active: [active('A', ['.'])] }))
      .toEqual({ action: 'queued', reason: 'overlap', waitingFor: ['A'] })
  })
})

describe('the stored text', () => {
  it('"." is stored as the root and read back as the root', () => {
    const stored = normalizeScopeField(['./'])
    expect(stored).toEqual({ ok: true, value: '.' })
    expect(parseScopeText('.')).toEqual(['.'])
  })

  it('equivalent spellings are stored once, in the clean form', () => {
    expect(normalizeScopeField(['src/./games', 'src//games', './src/games/'])).toEqual({ ok: true, value: 'src/games' })
  })

  it('an escaping entry is still an error, not a drop', () => {
    expect(normalizeScopeField(['src', './../x']).ok).toBe(false)
  })
})
