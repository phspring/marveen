// A stacked ticket is cut from another ticket's own branch (the `stacked` decision), so it carries that ticket's
// unpushed work. Real git, throwaway repos.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import { planWorkspace, createWorkspace, removeWorkspace, inspectWorkspace, listWorkspaces, type WorkspacePlan } from '../web/workspace.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}
let base: string
let plain: ProjectConfig
let sub: ProjectConfig

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}

beforeAll(() => {
  for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] }
  base = mkdtempSync(join(tmpdir(), 'ws-stack-'))
  git(base, 'init', '--bare', 'origin.git')
  git(base, 'clone', '-q', 'origin.git', 'repo')
  writeFileSync(join(base, 'repo', 'a.txt'), 'one\n')
  git(join(base, 'repo'), 'add', '.'); git(join(base, 'repo'), 'commit', '-qm', 'init'); git(join(base, 'repo'), 'push', '-q', 'origin', 'HEAD:develop')
  const reg = normalizeProjectRegistry({
    projects: {
      plain: { repoPath: join(base, 'repo'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 8, onOverlap: 'stack' },
      sub: { repoPath: join(base, 'repo'), repoKind: 'submodule', mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 8 },
    },
  })
  plain = reg.projects.find((p) => p.name === 'plain')!
  sub = reg.projects.find((p) => p.name === 'sub')!
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ }
})

function planOf(p: ProjectConfig, ticket: string, stackOn?: string): WorkspacePlan {
  const r = planWorkspace(p, ticket, stackOn ? { stackOn: { branch: stackOn } } : {})
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

describe('planWorkspace with stackOn', () => {
  it('starts from the other ticket\'s local branch and records it as the base', () => {
    const p = planOf(plain, 'S-2', 'feature/S-1')
    expect(p).toMatchObject({ baseBranch: 'feature/S-1', baseRef: 'feature/S-1', branch: 'feature/S-2' })
    expect(planOf(plain, 'S-3')).toMatchObject({ baseBranch: 'develop', baseRef: 'origin/develop' })
  })

  it('is refused for a clone (submodule) project, for an unsafe branch and for stacking on itself', () => {
    expect(planWorkspace(sub, 'S-2', { stackOn: { branch: 'feature/S-1' } }).ok).toBe(false)
    expect(planWorkspace(plain, 'S-2', { stackOn: { branch: '../x' } }).ok).toBe(false)
    expect(planWorkspace(plain, 'S-2', { stackOn: { branch: 'feature/S-2' } }).ok).toBe(false)
  })

  it('createWorkspace refuses a hand-made plan whose base ref is neither origin/<base> nor the stacked branch', async () => {
    const p = { ...planOf(plain, 'S-4'), baseRef: 'origin/somewhere-else' }
    expect((await createWorkspace(p)).ok).toBe(false)
    const c = { ...planOf(sub, 'S-5'), baseBranch: 'develop', baseRef: 'develop' }
    expect((await createWorkspace(c)).ok).toBe(false)
  })
})

describe('a stacked workspace', () => {
  it('carries the first ticket\'s unpushed commit, records the chain and leaves the first ticket alone', async () => {
    const first = planOf(plain, 'S-1')
    expect(await createWorkspace(first)).toMatchObject({ ok: true, created: true })
    writeFileSync(join(first.path, 'first.txt'), 'from the first ticket\n')
    git(first.path, 'add', '.'); git(first.path, 'commit', '-qm', 'first ticket work')

    const second = planOf(plain, 'S-2', 'feature/S-1')
    expect(await createWorkspace(second)).toMatchObject({ ok: true, created: true })
    expect(readFileSync(join(second.path, 'first.txt'), 'utf-8')).toBe('from the first ticket\n')
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/S-2')

    const markers = listWorkspaces(plain)
    expect(markers.find((m) => m.ticket === 'S-2')).toMatchObject({ baseBranch: 'feature/S-1', branch: 'feature/S-2' })
    expect(markers.find((m) => m.ticket === 'S-1')).toMatchObject({ baseBranch: 'develop' })

    // the first ticket's checkout is untouched
    expect(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/S-1')
    expect(git(first.path, 'status', '--porcelain')).toBe('')
  })

  it('removal of the stacked ticket refuses while it holds the first ticket\'s unpushed work, and a forced one keeps the first', async () => {
    const first = planOf(plain, 'S-1')
    const second = planOf(plain, 'S-2', 'feature/S-1')
    // S-2's HEAD is the first ticket's unpushed commit: no remote has seen it
    expect(await inspectWorkspace(second)).toMatchObject({ dirty: false, unpushed: true })
    expect((await removeWorkspace(second)).ok).toBe(false)
    expect(existsSync(second.path)).toBe(true)

    expect(await removeWorkspace(second, { force: true })).toMatchObject({ ok: true, removed: true })
    expect(existsSync(second.path)).toBe(false)
    expect(existsSync(first.path)).toBe(true)
    expect(readFileSync(join(first.path, 'first.txt'), 'utf-8')).toBe('from the first ticket\n')
    await removeWorkspace(first, { force: true })
  })

  it('a missing base branch is an error that leaves nothing behind', async () => {
    const orphan = planOf(plain, 'S-6', 'feature/does-not-exist')
    const r = await createWorkspace(orphan)
    expect(r.ok).toBe(false)
    expect(existsSync(orphan.path)).toBe(false)
    expect(existsSync(orphan.markerPath)).toBe(false)
    expect(git(join(base, 'repo'), 'branch', '--list', 'feature/S-6').trim()).toBe('')
  })
})
