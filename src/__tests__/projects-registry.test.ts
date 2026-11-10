import { describe, it, expect } from 'vitest'
import {
  normalizeProjectRegistry, resolveProject, jiraKeyOf, isolatesTickets, isSafeBranchName, pathInside,
  DEFAULT_BASE_BRANCH, DEFAULT_MAX_PARALLEL,
} from '../projects.js'

const raw = {
  projects: {
    'tover.tafel': { repoPath: '/var/www/tover/tover.tafel', repoKind: 'submodule', mode: 'worktree', workspaceRoot: '/home/u/ws', jiraKeys: ['tvr'], maxParallel: 3 },
    'tover': { repoPath: '/var/www/tover', mode: 'worktree', workspaceRoot: '/home/u/ws', jiraKeys: ['TVR', 'OPS'] },
    'plain': { repoPath: '/srv/plain' },
  },
}

describe('normalizeProjectRegistry', () => {
  it('is empty for anything that is not a registry', () => {
    for (const v of [null, undefined, 'x', 3, [], {}, { projects: [] }, { projects: 'x' }]) {
      expect(normalizeProjectRegistry(v).projects).toEqual([])
    }
  })

  it('fills the defaults and keeps a valid worktree entry', () => {
    const r = normalizeProjectRegistry(raw)
    const tt = r.projects.find((p) => p.name === 'tover.tafel')!
    expect(tt).toMatchObject({ repoKind: 'submodule', mode: 'worktree', baseBranch: DEFAULT_BASE_BRANCH, jiraKeys: ['TVR'], maxParallel: 3 })
    const plain = r.projects.find((p) => p.name === 'plain')!
    expect(plain).toMatchObject({ repoKind: 'plain', mode: 'shared', workspaceRoot: null, jiraKeys: [], maxParallel: DEFAULT_MAX_PARALLEL })
  })

  it('a Jira key belongs to one project: the second claim is ignored and reported', () => {
    const r = normalizeProjectRegistry(raw)
    expect(r.projects.find((p) => p.name === 'tover')!.jiraKeys).toEqual(['OPS'])
    expect(r.problems.some((l) => l.includes('TVR') && l.includes('tover.tafel'))).toBe(true)
  })

  it('worktree mode without a usable workspaceRoot stays shared', () => {
    const r = normalizeProjectRegistry({ projects: { a: { repoPath: '/r', mode: 'worktree' }, b: { repoPath: '/r', mode: 'worktree', workspaceRoot: 'relative/dir' } } })
    expect(r.projects.map((p) => p.mode)).toEqual(['shared', 'shared'])
    expect(r.problems.length).toBeGreaterThanOrEqual(2)
  })

  it('a workspaceRoot that contains the repo, or lies inside it, is refused', () => {
    const inside = normalizeProjectRegistry({ projects: { a: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: '/r/app/ws' } } })
    const around = normalizeProjectRegistry({ projects: { a: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: '/r' } } })
    expect(inside.projects[0].mode).toBe('shared')
    expect(around.projects[0].mode).toBe('shared')
    // a sibling that only shares a name prefix is fine
    const sibling = normalizeProjectRegistry({ projects: { a: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: '/r/app-wt' } } })
    expect(sibling.projects[0].mode).toBe('worktree')
  })

  it('drops entries with a relative or missing repoPath and duplicate names (case-insensitive)', () => {
    const r = normalizeProjectRegistry({ projects: { a: { repoPath: 'rel' }, b: {}, C: { repoPath: '/c' }, c: { repoPath: '/d' } } })
    expect(r.projects.map((p) => p.name)).toEqual(['C'])
  })

  it('rejects unsafe base branches and bad maxParallel, falling back to the defaults', () => {
    const r = normalizeProjectRegistry({ projects: { a: { repoPath: '/a', baseBranch: '../x', maxParallel: 99 }, b: { repoPath: '/b', maxParallel: 1.5 } } })
    expect(r.projects[0]).toMatchObject({ baseBranch: DEFAULT_BASE_BRANCH, maxParallel: DEFAULT_MAX_PARALLEL })
    expect(r.projects[1].maxParallel).toBe(DEFAULT_MAX_PARALLEL)
  })

  it('does not carry setup/teardown commands: they are not part of the registry yet', () => {
    const r = normalizeProjectRegistry({ projects: { a: { repoPath: '/a', setup: ['rm', '-rf', '/'], teardown: ['x'] } } })
    expect(Object.keys(r.projects[0])).not.toContain('setup')
    expect(Object.keys(r.projects[0])).not.toContain('teardown')
  })
})

describe('helpers', () => {
  it('jiraKeyOf', () => {
    expect(jiraKeyOf('TVR-2658')).toBe('TVR')
    expect(jiraKeyOf(' tvr-1 ')).toBe('TVR')
    for (const v of ['TVR', 'TVR-', '2658', 'x', '', null, undefined, 'TVR-12a']) expect(jiraKeyOf(v)).toBeNull()
  })

  it('isSafeBranchName', () => {
    for (const ok of ['develop', 'feature/TVR-1', 'a.b/c_d']) expect(isSafeBranchName(ok)).toBe(true)
    for (const bad of ['', '-x', '../x', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', 'a b', '.hid/x', 'x/.y', 3, null]) expect(isSafeBranchName(bad)).toBe(false)
  })

  it('pathInside works on path boundaries', () => {
    expect(pathInside('/a/b', '/a/b')).toBe(true)
    expect(pathInside('/a/b/c', '/a/b')).toBe(true)
    expect(pathInside('/a/bc', '/a/b')).toBe(false)
  })
})

describe('resolveProject', () => {
  const reg = normalizeProjectRegistry(raw)

  it('1. the card project wins, case-insensitively', () => {
    expect(resolveProject({ project: 'TOVER.TAFEL', externalRef: 'OPS-1' }, reg)).toMatchObject({ via: 'card', project: { name: 'tover.tafel' } })
  })

  it('a card project that is not registered is final: no fall-through to Jira or the directory', () => {
    expect(resolveProject({ project: 'unknown', externalRef: 'OPS-1', cwd: '/srv/plain/src' }, reg)).toBeNull()
  })

  it('2. the Jira key prefix finds the project when the card has none', () => {
    expect(resolveProject({ externalRef: 'ops-12' }, reg)).toMatchObject({ via: 'jira', project: { name: 'tover' } })
    expect(resolveProject({ project: '  ', externalRef: 'TVR-9' }, reg)).toMatchObject({ via: 'jira', project: { name: 'tover.tafel' } })
  })

  it('3. the directory is the last resort, and the longest repoPath wins', () => {
    expect(resolveProject({ cwd: '/var/www/tover/tover.tafel/src/x' }, reg)).toMatchObject({ via: 'directory', project: { name: 'tover.tafel' } })
    expect(resolveProject({ cwd: '/var/www/tover/other' }, reg)).toMatchObject({ via: 'directory', project: { name: 'tover' } })
    expect(resolveProject({ externalRef: 'NOPE-1', cwd: '/srv/plain' }, reg)).toMatchObject({ via: 'directory', project: { name: 'plain' } })
  })

  it('a directory that only shares a name prefix does not match', () => {
    expect(resolveProject({ cwd: '/srv/plainer' }, reg)).toBeNull()
  })

  it('returns null when nothing matches (the caller keeps the shared, today behaviour)', () => {
    expect(resolveProject({}, reg)).toBeNull()
    expect(resolveProject({ cwd: 'relative' }, reg)).toBeNull()
  })
})

describe('isolatesTickets', () => {
  it('only a worktree project with a workspaceRoot isolates', () => {
    const r = normalizeProjectRegistry(raw)
    expect(r.projects.map((p) => [p.name, isolatesTickets(p)])).toEqual([['tover.tafel', true], ['tover', true], ['plain', false]])
  })
})
