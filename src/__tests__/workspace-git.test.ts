// Real git, throwaway repos: the workspace module against an ordinary repo (worktree) and a repo whose main
// checkout is a submodule (self-contained clone). Nothing here touches the checkout the tests run in.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import {
  planWorkspace, createWorkspace, inspectWorkspace, removeWorkspace, listWorkspaces, orphanWorkspaces, hasCapacity,
  type WorkspacePlan,
} from '../web/workspace.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}

let base: string
let plain: ProjectConfig
let sub: ProjectConfig
let subOrigin: string

function planOf(p: ProjectConfig, ticket: string, branch?: string): WorkspacePlan {
  const r = planWorkspace(p, ticket, branch ? { branch } : {})
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

beforeAll(() => {
  for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] }
  base = mkdtempSync(join(tmpdir(), 'ws-git-'))

  // ordinary repo: origin (bare) + a clone with one commit on develop
  git(base, 'init', '--bare', 'plain-origin.git')
  git(base, 'clone', '-q', 'plain-origin.git', 'plain')
  writeFileSync(join(base, 'plain', 'a.txt'), 'one\n')
  git(join(base, 'plain'), 'add', '.'); git(join(base, 'plain'), 'commit', '-qm', 'init'); git(join(base, 'plain'), 'push', '-q', 'origin', 'HEAD:develop')

  // submodule: a super repo whose main checkout of `subm` is an absorbed submodule
  git(base, 'init', '--bare', 'sub-origin.git')
  git(base, 'clone', '-q', 'sub-origin.git', 'sub-seed')
  writeFileSync(join(base, 'sub-seed', 'b.txt'), 'two\n')
  git(join(base, 'sub-seed'), 'add', '.'); git(join(base, 'sub-seed'), 'commit', '-qm', 'init'); git(join(base, 'sub-seed'), 'push', '-q', 'origin', 'HEAD:develop')
  git(base, 'init', '--bare', 'super-origin.git')
  git(base, 'clone', '-q', 'super-origin.git', 'super-seed')
  git(join(base, 'super-seed'), 'submodule', 'add', '-q', '-b', 'develop', join(base, 'sub-origin.git'), 'subm')
  git(join(base, 'super-seed'), 'commit', '-qm', 'add subm'); git(join(base, 'super-seed'), 'push', '-q', 'origin', 'HEAD:develop')
  git(base, 'clone', '-q', '--recurse-submodules', '-b', 'develop', 'super-origin.git', 'super')
  subOrigin = join(base, 'sub-origin.git')

  const reg = normalizeProjectRegistry({
    projects: {
      plain: { repoPath: join(base, 'plain'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 2 },
      sub: { repoPath: join(base, 'super', 'subm'), repoKind: 'submodule', mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 1 },
    },
  })
  plain = reg.projects.find((p) => p.name === 'plain')!
  sub = reg.projects.find((p) => p.name === 'sub')!
  if (!plain || !sub) throw new Error(`registry setup failed: ${reg.problems.join('; ')}`)
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('worktree workspace (ordinary repo)', () => {
  it('creates an isolated checkout on its own branch, leaves the main checkout alone, and is idempotent', async () => {
    const plan = planOf(plain, 'T-1')
    const r = await createWorkspace(plan)
    expect(r).toMatchObject({ ok: true, created: true })
    expect(readFileSync(join(plan.path, 'a.txt'), 'utf-8')).toBe('one\n')
    expect(git(plan.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/T-1')
    expect(git(plan.path, 'status', '--porcelain')).toBe('')
    expect(plan.markerPath.startsWith(plan.path)).toBe(false)
    expect(git(join(base, 'plain'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('develop')
    expect(git(join(base, 'plain'), 'status', '--porcelain')).toBe('')

    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: false })
  })

  it('works even when the caller has GIT_DIR / GIT_WORK_TREE set (they are stripped)', async () => {
    const plan = planOf(plain, 'T-env')
    process.env.GIT_DIR = '/nonexistent/.git'
    process.env.GIT_WORK_TREE = '/nonexistent'
    try {
      expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: true })
    } finally {
      delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE
    }
    expect(git(plan.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/T-env')
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
  })

  it('refuses a branch that already exists, and a path it did not create', async () => {
    const taken = await createWorkspace(planOf(plain, 'T-2', 'feature/T-1'))
    expect(taken.ok).toBe(false)
    expect(existsSync(planOf(plain, 'T-2').path)).toBe(false)
  })

  it('cleans up after a failure: a missing base branch leaves no path, branch or marker', async () => {
    const broken = { ...plain, baseBranch: 'no-such-branch' }
    const plan = planOf(broken, 'T-3')
    const r = await createWorkspace(plan)
    expect(r.ok).toBe(false)
    expect(existsSync(plan.path)).toBe(false)
    expect(existsSync(plan.markerPath)).toBe(false)
    expect(git(join(base, 'plain'), 'branch', '--list', 'feature/T-3').trim()).toBe('')
  })

  it('does not throw work away: dirty and unpushed workspaces are kept unless forced', async () => {
    const plan = planOf(plain, 'T-4')
    await createWorkspace(plan)
    expect(await inspectWorkspace(plan)).toEqual({ exists: true, dirty: false, unpushed: false })

    writeFileSync(join(plan.path, 'new.txt'), 'x\n')
    const dirty = await removeWorkspace(plan)
    expect(dirty).toMatchObject({ ok: false })
    expect(existsSync(plan.path)).toBe(true)

    git(plan.path, 'add', '.'); git(plan.path, 'commit', '-qm', 'work')
    expect(await inspectWorkspace(plan)).toMatchObject({ dirty: false, unpushed: true })
    expect((await removeWorkspace(plan)).ok).toBe(false)

    git(plan.path, 'push', '-q', 'origin', 'feature/T-4')
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
    expect(existsSync(plan.path)).toBe(false)
    expect(existsSync(plan.markerPath)).toBe(false)
    // the branch is kept: its commits may still be wanted
    expect(git(join(base, 'plain'), 'branch', '--list', 'feature/T-4').trim()).not.toBe('')
    expect(git(join(base, 'plain'), 'worktree', 'list')).not.toContain('T-4')
  })

  it('force removes a dirty workspace', async () => {
    const plan = planOf(plain, 'T-5')
    await createWorkspace(plan)
    writeFileSync(join(plan.path, 'junk.txt'), 'x\n')
    expect(await removeWorkspace(plan, { force: true })).toMatchObject({ ok: true, removed: true })
    expect(existsSync(plan.path)).toBe(false)
  })

  it('lists, reports orphans and counts capacity', async () => {
    const a = planOf(plain, 'T-6'); const b = planOf(plain, 'T-7')
    await createWorkspace(a)
    const before = listWorkspaces(plain).length
    expect(hasCapacity(plain)).toBe(before < 2)
    await createWorkspace(b)
    expect(listWorkspaces(plain).map((m) => m.ticket)).toEqual(expect.arrayContaining(['T-1', 'T-6', 'T-7']))
    expect(orphanWorkspaces(plain, ['T-1', 'T-6']).map((m) => m.ticket)).toEqual(['T-7'])
    expect(hasCapacity(plain)).toBe(false)
    await removeWorkspace(a); await removeWorkspace(b, { force: true })
  })

  it('removing something that was never created is a no-op', async () => {
    expect(await removeWorkspace(planOf(plain, 'T-never'))).toMatchObject({ ok: true, removed: false })
  })
})

describe('clone workspace (submodule)', () => {
  it('creates a self-contained clone: no core.worktree, a real .git directory, no shared object store', async () => {
    const plan = planOf(sub, 'S-1')
    expect(plan.kind).toBe('clone')
    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: true })

    expect(readFileSync(join(plan.path, 'b.txt'), 'utf-8')).toBe('two\n')
    expect(git(plan.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/S-1')
    expect(git(plan.path, 'rev-parse', '--git-dir').trim()).toBe('.git')
    expect(() => git(plan.path, 'config', '--get', 'core.worktree')).toThrow()
    expect(existsSync(join(plan.path, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    expect(git(plan.path, 'remote', 'get-url', 'origin').trim()).toBe(subOrigin)
    expect(git(plan.path, 'status', '--porcelain')).toBe('')
  })

  it('work and pushes in the clone leave the main submodule checkout untouched', async () => {
    const plan = planOf(sub, 'S-1')
    writeFileSync(join(plan.path, 'b.txt'), 'changed\n')
    git(plan.path, 'commit', '-qam', 'ticket change')
    git(plan.path, 'push', '-q', 'origin', 'feature/S-1')

    const main = join(base, 'super', 'subm')
    expect(readFileSync(join(main, 'b.txt'), 'utf-8')).toBe('two\n')
    expect(git(main, 'status', '--porcelain')).toBe('')
    expect(git(main, 'branch', '--list', 'feature/*').trim()).toBe('')
    expect(git(join(base, 'super'), 'status', '--porcelain')).toBe('')
    expect(git(subOrigin, 'branch', '--list', 'feature/S-1').trim()).not.toBe('')
  })

  it('removes the pushed clone, and the capacity limit of 1 is honoured', async () => {
    const plan = planOf(sub, 'S-1')
    expect(hasCapacity(sub)).toBe(false)
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
    expect(existsSync(plan.path)).toBe(false)
    expect(hasCapacity(sub)).toBe(true)
  })

  it('a clone with unpushed commits is kept', async () => {
    const plan = planOf(sub, 'S-2')
    await createWorkspace(plan)
    writeFileSync(join(plan.path, 'b.txt'), 'wip\n')
    git(plan.path, 'commit', '-qam', 'wip')
    expect((await removeWorkspace(plan)).ok).toBe(false)
    expect(existsSync(plan.path)).toBe(true)
    expect(await removeWorkspace(plan, { force: true })).toMatchObject({ ok: true, removed: true })
  })
})
