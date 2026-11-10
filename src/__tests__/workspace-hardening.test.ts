// Findings from the Copilot review of PR #1, each reproduced here before it was fixed:
//   - a failed concurrent create must never delete the workspace another call made;
//   - the clone's origin URL must not be able to act as a git option;
//   - createWorkspace must not trust the plan it is handed (path escape, stale or foreign marker).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import { planWorkspace, createWorkspace, removeWorkspace, type GitRunner, type WorkspacePlan } from '../web/workspace.js'

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const saved: Record<string, string | undefined> = {}
let base: string
let plain: ProjectConfig
let sub: ProjectConfig

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=develop', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } })
}
function planOf(p: ProjectConfig, ticket: string): WorkspacePlan {
  const r = planWorkspace(p, ticket)
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

/** A git runner that records every call and answers `remote get-url` with a chosen URL. */
function recorder(originUrl = 'https://example.test/r.git') {
  const calls: string[][] = []
  const run: GitRunner = async (args) => {
    calls.push(args)
    if (args.includes('get-url')) return `${originUrl}\n`
    return ''
  }
  return { calls, run }
}

beforeAll(() => {
  for (const k of Object.keys(IDENT)) { saved[k] = process.env[k]; process.env[k] = IDENT[k as keyof typeof IDENT] }
  base = mkdtempSync(join(tmpdir(), 'ws-hard-'))
  git(base, 'init', '--bare', 'origin.git')
  git(base, 'clone', '-q', 'origin.git', 'repo')
  writeFileSync(join(base, 'repo', 'a.txt'), 'one\n')
  git(join(base, 'repo'), 'add', '.'); git(join(base, 'repo'), 'commit', '-qm', 'init'); git(join(base, 'repo'), 'push', '-q', 'origin', 'HEAD:develop')
  const reg = normalizeProjectRegistry({
    projects: {
      plain: { repoPath: join(base, 'repo'), mode: 'worktree', workspaceRoot: join(base, 'ws'), maxParallel: 8 },
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

describe('concurrent create of the same workspace', () => {
  it('both calls succeed, exactly one creates, and the workspace and its marker survive', async () => {
    const plan = planOf(plain, 'C-1')
    const [a, b] = await Promise.all([createWorkspace(plan), createWorkspace(plan)])
    expect(a.ok && b.ok).toBe(true)
    expect([a, b].filter((r) => r.ok && r.created)).toHaveLength(1)
    expect(existsSync(plan.path)).toBe(true)
    expect(existsSync(plan.markerPath)).toBe(true)
    expect(git(plan.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/C-1')
    await removeWorkspace(plan, { force: true })
  })

  it('a create racing a remove of the same workspace ends in one consistent state', async () => {
    const plan = planOf(plain, 'C-2')
    await createWorkspace(plan)
    await Promise.all([removeWorkspace(plan, { force: true }), createWorkspace(plan)])
    // either order is fine, but the marker and the directory must agree
    expect(existsSync(plan.markerPath)).toBe(existsSync(plan.path))
    await removeWorkspace(plan, { force: true })
  })

  it('different tickets are not serialised against each other', async () => {
    const [a, b] = await Promise.all([createWorkspace(planOf(plain, 'C-3')), createWorkspace(planOf(plain, 'C-4'))])
    expect(a.ok && b.ok).toBe(true)
    await removeWorkspace(planOf(plain, 'C-3'), { force: true }); await removeWorkspace(planOf(plain, 'C-4'), { force: true })
  })
})

describe('the clone origin URL', () => {
  it('is passed after "--" so a URL that starts with a dash can never act as a git option', async () => {
    const { calls, run } = recorder('--upload-pack=touch /tmp/pwned')
    const plan = planOf(sub, 'U-1')
    const r = await createWorkspace(plan, run)
    expect(r.ok).toBe(true)
    const clone = calls.find((a) => a[0] === 'clone')!
    const at = clone.indexOf('--upload-pack=touch /tmp/pwned')
    expect(at).toBeGreaterThan(0)
    expect(clone[at - 1]).toBe('--')
    // the path operand follows the URL
    expect(clone[at + 1]).toBe(plan.path)
    rmSync(plan.markerPath, { force: true })
  })
})

describe('createWorkspace does not trust the plan it is handed', () => {
  it('refuses a plan whose path leaves its project directory, and runs no git', async () => {
    const plan = { ...planOf(plain, 'P-1'), path: join(base, 'elsewhere') }
    const { calls, run } = recorder()
    const r = await createWorkspace(plan, run)
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(existsSync(plan.path)).toBe(false)
  })

  it('refuses a plan whose marker would sit inside the working tree, or whose branch is unsafe', async () => {
    const p = planOf(plain, 'P-2')
    const { calls, run } = recorder()
    expect((await createWorkspace({ ...p, markerPath: join(p.path, 'marker.json') }, run)).ok).toBe(false)
    expect((await createWorkspace({ ...p, branch: '--force' }, run)).ok).toBe(false)
    expect((await createWorkspace({ ...p, baseBranch: '../x' }, run)).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does not reuse a marker that disagrees with the plan (another kind, repo or branch)', async () => {
    const plan = planOf(plain, 'P-3')
    mkdirSync(plan.path, { recursive: true })
    mkdirSync(join(plan.markerPath, '..'), { recursive: true })
    const stale = { project: plan.project, ticket: plan.ticket, kind: 'clone', repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseBranch: plan.baseBranch, createdAt: new Date().toISOString() }
    writeFileSync(plan.markerPath, JSON.stringify(stale))
    const { calls, run } = recorder()
    const r = await createWorkspace(plan, run)
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
    rmSync(plan.path, { recursive: true, force: true }); rmSync(plan.markerPath, { force: true })
  })

  it('a marker that matches the plan is still reused (idempotent)', async () => {
    const plan = planOf(plain, 'P-4')
    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: true })
    expect(await createWorkspace(plan)).toMatchObject({ ok: true, created: false })
    await removeWorkspace(plan, { force: true })
  })
})
