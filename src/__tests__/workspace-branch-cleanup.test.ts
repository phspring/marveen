// A ticket branch that holds nothing of its own must never block the next attempt at the same ticket, and a branch
// with work of its own must never be dropped. Real git.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import { planWorkspace, createWorkspace, removeWorkspace, type WorkspacePlan } from '../web/workspace.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}
let base: string
let plain: ProjectConfig

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}
const planOf = (t: string, stackOn?: string): WorkspacePlan => {
  const r = planWorkspace(plain, t, stackOn ? { stackOn: { branch: stackOn } } : {})
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const branches = (): string => git(join(base, 'repo'), 'branch', '--list', 'feature/*').trim()

beforeAll(() => {
  for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] }
  base = mkdtempSync(join(tmpdir(), 'ws-branch-'))
  git(base, 'init', '--bare', 'origin.git')
  git(base, 'clone', '-q', 'origin.git', 'repo')
  writeFileSync(join(base, 'repo', 'a.txt'), 'one\n')
  git(join(base, 'repo'), 'add', '.'); git(join(base, 'repo'), 'commit', '-qm', 'init'); git(join(base, 'repo'), 'push', '-q', 'origin', 'HEAD:develop')
  plain = normalizeProjectRegistry({ projects: { p: { repoPath: join(base, 'repo'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 9, onOverlap: 'stack' } } }).projects[0]
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('a branch that holds nothing', () => {
  it('is dropped when its workspace is removed, so the same ticket can be created again', async () => {
    const plan = planOf('B-1')
    await createWorkspace(plan)
    expect(branches()).toContain('feature/B-1')
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
    expect(branches()).not.toContain('feature/B-1')
    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: true })
    await removeWorkspace(plan, { force: true })
  })

  it('left behind by something else (no workspace, no marker) is cleared by the next create instead of blocking it', async () => {
    git(join(base, 'repo'), 'branch', 'feature/B-2', 'origin/develop')
    const plan = planOf('B-2')
    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: true })
    expect(existsSync(plan.path)).toBe(true)
    await removeWorkspace(plan, { force: true })
  })

  it('is still dropped when the base moved on in the meantime (its commits are all in the base)', async () => {
    const plan = planOf('B-3')
    await createWorkspace(plan)
    // origin/develop advances
    const other = join(base, 'other')
    git(base, 'clone', '-q', 'origin.git', 'other')
    writeFileSync(join(other, 'b.txt'), 'two\n')
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'move on'); git(other, 'push', '-q', 'origin', 'HEAD:develop')
    git(join(base, 'repo'), 'fetch', '-q', 'origin')
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
    expect(branches()).not.toContain('feature/B-3')
  })
})

describe('a branch that holds work of its own', () => {
  it('is kept when its workspace is removed, pushed or not', async () => {
    const plan = planOf('W-1')
    await createWorkspace(plan)
    writeFileSync(join(plan.path, 'w.txt'), 'work\n')
    git(plan.path, 'add', '.'); git(plan.path, 'commit', '-qm', 'work'); git(plan.path, 'push', '-q', 'origin', 'feature/W-1')
    expect(await removeWorkspace(plan)).toMatchObject({ ok: true, removed: true })
    expect(branches()).toContain('feature/W-1')
  })

  it('blocks a new create under the same branch name with an error that says so, and is not touched', async () => {
    const before = git(join(base, 'repo'), 'rev-parse', 'feature/W-1').trim()
    const again = planOf('W-1')
    const r = await createWorkspace(again)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('holds work of its own')
    expect(git(join(base, 'repo'), 'rev-parse', 'feature/W-1').trim()).toBe(before)
    expect(existsSync(again.path)).toBe(false)
  })

  it('a stacked ticket\'s branch that is only ahead of the first ticket by nothing is dropped, one with a commit is kept', async () => {
    const first = planOf('K-1')
    await createWorkspace(first)
    writeFileSync(join(first.path, 'k1.txt'), 'k1\n')
    git(first.path, 'add', '.'); git(first.path, 'commit', '-qm', 'k1')

    const empty = planOf('K-2', 'feature/K-1')
    await createWorkspace(empty)
    await removeWorkspace(empty, { force: true })
    expect(branches()).not.toContain('feature/K-2')

    const busy = planOf('K-3', 'feature/K-1')
    await createWorkspace(busy)
    writeFileSync(join(busy.path, 'k3.txt'), 'k3\n')
    git(busy.path, 'add', '.'); git(busy.path, 'commit', '-qm', 'k3')
    await removeWorkspace(busy, { force: true })
    expect(branches()).toContain('feature/K-3')
    await removeWorkspace(first, { force: true })
  })
})
