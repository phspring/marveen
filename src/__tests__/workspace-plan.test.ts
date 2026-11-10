import { describe, it, expect } from 'vitest'
import { normalizeProjectRegistry } from '../projects.js'
import { planWorkspace, ticketSlug, projectSlug, cleanGitEnv } from '../web/workspace.js'

const reg = normalizeProjectRegistry({
  projects: {
    'tover.tafel': { repoPath: '/var/www/tover/tover.tafel', repoKind: 'submodule', mode: 'worktree', workspaceRoot: '/home/u/ws' },
    'Laravel App': { repoPath: '/srv/app', mode: 'worktree', workspaceRoot: '/home/u/ws', baseBranch: 'main' },
    'shared': { repoPath: '/srv/shared' },
  },
})
const byName = (n: string) => reg.projects.find((p) => p.name === n)!

describe('ticketSlug', () => {
  it('accepts normal ticket ids', () => {
    for (const t of ['TVR-2658', 'a', 'x.y_z-1', ' TVR-1 ']) expect(ticketSlug(t)).not.toBeNull()
  })
  it('refuses anything that could leave the directory or confuse git', () => {
    for (const t of ['', '..', '../x', 'a/b', 'a b', '-x', '.x', 'a..b', 'a.', 'a.lock', 'a\u0000b', 'x'.repeat(65), 3, null, undefined]) {
      expect(ticketSlug(t)).toBeNull()
    }
  })
})

describe('projectSlug', () => {
  it('makes a directory-safe name that cannot be dot-led or empty', () => {
    expect(projectSlug('Laravel App')).toBe('Laravel_App')
    expect(projectSlug('../etc')).toBe('etc')
    expect(projectSlug('...')).toBe('project')
    expect(projectSlug('árvíz')).toBe('rv_z')
  })
})

describe('planWorkspace', () => {
  it('plans a worktree for a plain repo, branch feature/<ticket> off the base', () => {
    const r = planWorkspace(byName('Laravel App'), 'TVR-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan).toMatchObject({
      kind: 'worktree', baseBranch: 'main', branch: 'feature/TVR-1',
      path: '/home/u/ws/Laravel_App/TVR-1', markerPath: '/home/u/ws/.marveen-workspaces/Laravel_App/TVR-1.json',
    })
  })

  it('plans a self-contained clone for a submodule', () => {
    const r = planWorkspace(byName('tover.tafel'), 'TVR-2658')
    expect(r.ok && r.plan.kind).toBe('clone')
  })

  it('the marker lives outside the working tree', () => {
    const r = planWorkspace(byName('tover.tafel'), 'TVR-2658')
    expect(r.ok && r.plan.markerPath.startsWith(r.plan.path)).toBe(false)
  })

  it('refuses a shared project, a bad ticket and a bad or base branch', () => {
    expect(planWorkspace(byName('shared'), 'T-1').ok).toBe(false)
    expect(planWorkspace(byName('tover.tafel'), '../x').ok).toBe(false)
    expect(planWorkspace(byName('tover.tafel'), 'T-1', { branch: '../x' }).ok).toBe(false)
    expect(planWorkspace(byName('Laravel App'), 'T-1', { branch: 'main' }).ok).toBe(false)
  })

  it('two projects with a colliding ticket id get different directories', () => {
    const a = planWorkspace(byName('tover.tafel'), 'T-1')
    const b = planWorkspace(byName('Laravel App'), 'T-1')
    expect(a.ok && b.ok && a.plan.path !== b.plan.path).toBe(true)
  })
})

describe('cleanGitEnv', () => {
  it('drops every variable that would redirect git, keeps the rest', () => {
    const out = cleanGitEnv({
      PATH: '/bin', HOME: '/h', GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_INDEX_FILE: '/i', GIT_COMMON_DIR: '/c',
      GIT_OBJECT_DIRECTORY: '/o', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/a', GIT_NAMESPACE: 'n',
      GIT_CONFIG: '/cfg', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', GIT_AUTHOR_NAME: 'me', GIT_SSH_COMMAND: 'ssh -i k',
    })
    expect(Object.keys(out).sort()).toEqual(['GIT_AUTHOR_NAME', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH'])
    expect(out.GIT_TERMINAL_PROMPT).toBe('0')
  })
})
