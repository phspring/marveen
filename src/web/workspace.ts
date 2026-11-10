// Ticket workspaces: one isolated checkout (and branch) per ticket, created and removed by the DASHBOARD process.
//
// Why the dashboard and not the agent: the db-write-gate (APPROVALDBGATE1030) restricts what an agent's Bash may do
// with git, and forbids GIT_DIR / GIT_WORK_TREE outright. This module is ordinary dashboard code, so it is not under
// that gate. It still never sets those variables (and strips them from the environment it passes on), and every git
// call is `git -C <literal path>` run without a shell. An agent then works inside the finished workspace with plain
// `git -C <literal path>` commands, which the gate allows outside the install.
//
// Two methods, chosen by the repo kind (a measured decision, docs/jegy-kornyezet.md):
//   worktree  an ordinary repo gets `git worktree add --no-track -b <branch> <path> origin/<base>`;
//   clone     a submodule gets a self-contained clone (`--reference <repo> --dissociate`): no `core.worktree`, no
//             shared refs or config with the main checkout, and no dependence on the main checkout's object store.
//
// Nothing calls this yet (step 2 of docs/jegy-kornyezet.md). Removal refuses to throw work away: a workspace with
// uncommitted changes or commits no remote has seen is kept unless `force` is passed.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { atomicWriteFileSync } from './atomic-write.js'
import { isSafeBranchName, isolatesTickets, pathInside, type ProjectConfig } from '../projects.js'

const execFileP = promisify(execFile)

export type WorkspaceKind = 'worktree' | 'clone'

export interface WorkspacePlan {
  project: string
  ticket: string
  kind: WorkspaceKind
  repoPath: string
  baseBranch: string
  branch: string
  /** The checkout the agent works in. */
  path: string
  /** `<root>/<projectSlug>`: everything this project owns lives below it. */
  projectDir: string
  /** Outside the working tree, so it never shows up in `git status`. */
  markerPath: string
}

export interface WorkspaceMarker {
  project: string
  ticket: string
  kind: WorkspaceKind
  repoPath: string
  path: string
  branch: string
  baseBranch: string
  createdAt: string
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

const TICKET_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MARKER_DIR = '.marveen-workspaces'

/** A ticket id that is safe as a directory name and a branch suffix, or null. */
export function ticketSlug(ticket: unknown): string | null {
  if (typeof ticket !== 'string') return null
  const t = ticket.trim()
  if (!TICKET_RX.test(t) || t.includes('..') || t.endsWith('.') || t.endsWith('.lock')) return null
  return t
}

export function projectSlug(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64)
  return s === '' ? 'project' : s
}

export function planWorkspace(p: ProjectConfig, ticket: unknown, opts: { branch?: string } = {}): Result<{ plan: WorkspacePlan }> {
  if (!isolatesTickets(p)) return { ok: false, error: `project "${p.name}" does not isolate tickets (mode is not worktree)` }
  const slug = ticketSlug(ticket)
  if (!slug) return { ok: false, error: 'invalid ticket id' }
  const branch = opts.branch ?? `feature/${slug}`
  if (!isSafeBranchName(branch)) return { ok: false, error: 'invalid branch name' }
  if (branch === p.baseBranch) return { ok: false, error: 'the ticket branch must differ from the base branch' }

  const root = p.workspaceRoot as string
  const projectDir = join(root, projectSlug(p.name))
  const path = join(projectDir, slug)
  if (!pathInside(path, projectDir) || path === projectDir) return { ok: false, error: 'workspace path escapes its root' }
  return {
    ok: true,
    plan: {
      project: p.name,
      ticket: slug,
      kind: p.repoKind === 'submodule' ? 'clone' : 'worktree',
      repoPath: p.repoPath,
      baseBranch: p.baseBranch,
      branch,
      path,
      projectDir,
      markerPath: join(root, MARKER_DIR, projectSlug(p.name), `${slug}.json`),
    },
  }
}

/** Run git with these arguments; resolves with stdout, rejects with a readable message. */
export type GitRunner = (args: string[]) => Promise<string>

// Variables that would redirect git to a different repository, work tree or object store.
const REDIRECTING_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(_.*)?)$/

export function cleanGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!REDIRECTING_ENV.test(k)) out[k] = v
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

export const defaultGit: GitRunner = async (args) => {
  try {
    const { stdout } = await execFileP('git', args, { env: cleanGitEnv(process.env), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`git ${args.slice(0, 4).join(' ')}: ${(e.stderr || e.message || 'failed').toString().trim().split('\n')[0]}`)
  }
}

function readMarker(markerPath: string): WorkspaceMarker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath, 'utf-8')) as Partial<WorkspaceMarker>
    if (m && typeof m.project === 'string' && typeof m.ticket === 'string' && typeof m.path === 'string'
      && typeof m.repoPath === 'string' && typeof m.branch === 'string' && (m.kind === 'worktree' || m.kind === 'clone')) {
      return m as WorkspaceMarker
    }
  } catch { /* absent or unreadable */ }
  return null
}

// One operation at a time per workspace path. The dashboard serves requests concurrently, and two creates (or a
// create and a remove) of the same ticket would otherwise race: the loser's cleanup deleted the winner's checkout.
// A chain per key, so different tickets never wait for each other. Single process by design: the dashboard is the
// only caller.
const chains = new Map<string, Promise<unknown>>()

function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

/**
 * A plan is data a caller hands in, so re-check what planWorkspace guarantees before anything touches the disk or
 * runs git: the path stays strictly inside the project directory, the marker is outside the working tree, and the
 * ticket, branches and repo path are the safe shapes. Null when the plan is sound.
 */
export function planProblem(plan: WorkspacePlan): string | null {
  if (plan.kind !== 'worktree' && plan.kind !== 'clone') return 'unknown workspace kind'
  if (ticketSlug(plan.ticket) !== plan.ticket) return 'invalid ticket id'
  if (!isSafeBranchName(plan.branch) || !isSafeBranchName(plan.baseBranch) || plan.branch === plan.baseBranch) return 'invalid branch name'
  if (!isAbsolute(plan.repoPath) || plan.repoPath.includes('\u0000')) return 'invalid repo path'
  if (!isAbsolute(plan.projectDir) || !isAbsolute(plan.path) || !isAbsolute(plan.markerPath)) return 'workspace paths must be absolute'
  if (!pathInside(plan.path, plan.projectDir) || plan.path === plan.projectDir) return 'workspace path escapes its project directory'
  if (pathInside(plan.markerPath, plan.path) || pathInside(plan.path, plan.markerPath)) return 'the marker must be outside the working tree'
  if (pathInside(plan.path, plan.repoPath) || pathInside(plan.repoPath, plan.path)) return 'the workspace and the repo must not contain each other'
  return null
}

/** The marker is the one thing that says "this module made that checkout": it must describe exactly this plan. */
function markerMatches(m: WorkspaceMarker, plan: WorkspacePlan): boolean {
  return m.path === plan.path && m.kind === plan.kind && m.repoPath === plan.repoPath
    && m.branch === plan.branch && m.baseBranch === plan.baseBranch && m.project === plan.project && m.ticket === plan.ticket
}

/** Undo only what THIS call did (the branch it created, the worktree or clone it started), never a bare path. */
async function dropPartial(plan: WorkspacePlan, git: GitRunner, done: { worktree: boolean; clone: boolean; branch: boolean }): Promise<void> {
  try {
    if (done.worktree) {
      try { await git(['-C', plan.repoPath, 'worktree', 'remove', '--force', plan.path]) } catch { /* may not exist */ }
      try { await git(['-C', plan.repoPath, 'worktree', 'prune']) } catch { /* best effort */ }
    }
    if (done.branch) { try { await git(['-C', plan.repoPath, 'branch', '-D', plan.branch]) } catch { /* may not exist */ } }
    if ((done.clone || done.worktree) && existsSync(plan.path) && pathInside(plan.path, plan.projectDir) && plan.path !== plan.projectDir) {
      rmSync(plan.path, { recursive: true, force: true })
    }
  } catch { /* cleanup is best effort, the caller already has the original error */ }
}

/** Create the workspace. Idempotent: an existing workspace this module made for the same ticket is returned as is. */
export function createWorkspace(plan: WorkspacePlan, git: GitRunner = defaultGit): Promise<Result<{ created: boolean; path: string }>> {
  const bad = planProblem(plan)
  if (bad) return Promise.resolve({ ok: false, error: bad })
  return serialised(plan.path, () => createWorkspaceLocked(plan, git))
}

async function createWorkspaceLocked(plan: WorkspacePlan, git: GitRunner): Promise<Result<{ created: boolean; path: string }>> {
  const existing = readMarker(plan.markerPath)
  if (existing && existsSync(plan.path)) {
    return markerMatches(existing, plan)
      ? { ok: true, created: false, path: plan.path }
      : { ok: false, error: 'a workspace marker exists for this path but describes a different workspace, nothing changed' }
  }
  if (existsSync(plan.path)) return { ok: false, error: 'the workspace path already exists and was not created by this module' }

  mkdirSync(dirname(plan.path), { recursive: true })
  const done = { worktree: false, clone: false, branch: false }
  try {
    if (plan.kind === 'worktree') {
      try { await git(['-C', plan.repoPath, 'fetch', '--quiet', 'origin']) } catch { /* offline: use what is local */ }
      try {
        await git(['-C', plan.repoPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${plan.baseBranch}^{commit}`])
      } catch {
        return { ok: false, error: `origin/${plan.baseBranch} does not exist in the repo` }
      }
      let branchTaken = true
      try { await git(['-C', plan.repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]) } catch { branchTaken = false }
      if (branchTaken) return { ok: false, error: `branch ${plan.branch} already exists in the repo` }
      done.worktree = true
      done.branch = true
      await git(['-C', plan.repoPath, 'worktree', 'add', '--quiet', '--no-track', '-b', plan.branch, plan.path, `origin/${plan.baseBranch}`])
    } else {
      const url = (await git(['-C', plan.repoPath, 'remote', 'get-url', 'origin'])).trim()
      if (!url) return { ok: false, error: 'the repo has no origin remote' }
      done.clone = true
      // "--": the URL comes from the repo's config and must never be read as an option (--upload-pack=...)
      await git(['clone', '--quiet', '--reference', plan.repoPath, '--dissociate', '-b', plan.baseBranch, '--', url, plan.path])
      await git(['-C', plan.path, 'checkout', '--quiet', '-b', plan.branch])
    }
    const marker: WorkspaceMarker = {
      project: plan.project, ticket: plan.ticket, kind: plan.kind, repoPath: plan.repoPath,
      path: plan.path, branch: plan.branch, baseBranch: plan.baseBranch, createdAt: new Date().toISOString(),
    }
    mkdirSync(dirname(plan.markerPath), { recursive: true })
    atomicWriteFileSync(plan.markerPath, JSON.stringify(marker, null, 2))
    return { ok: true, created: true, path: plan.path }
  } catch (err) {
    await dropPartial(plan, git, done)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface WorkspaceState {
  exists: boolean
  dirty: boolean
  /** HEAD is contained in no remote-tracking branch: removing the workspace would lose these commits. */
  unpushed: boolean
}

export async function inspectWorkspace(plan: WorkspacePlan, git: GitRunner = defaultGit): Promise<WorkspaceState> {
  if (!existsSync(plan.path)) return { exists: false, dirty: false, unpushed: false }
  const dirty = (await git(['-C', plan.path, 'status', '--porcelain'])).trim() !== ''
  const unpushed = (await git(['-C', plan.path, 'branch', '-r', '--contains', 'HEAD'])).trim() === ''
  return { exists: true, dirty, unpushed }
}

/** Remove a workspace this module created. The branch is kept: its commits may still be wanted. */
export function removeWorkspace(plan: WorkspacePlan, opts: { force?: boolean } = {}, git: GitRunner = defaultGit): Promise<Result<{ removed: boolean }>> {
  const bad = planProblem(plan)
  if (bad) return Promise.resolve({ ok: false, error: bad })
  return serialised(plan.path, () => removeWorkspaceLocked(plan, opts, git))
}

async function removeWorkspaceLocked(plan: WorkspacePlan, opts: { force?: boolean }, git: GitRunner): Promise<Result<{ removed: boolean }>> {
  const marker = readMarker(plan.markerPath)
  if (!marker) return { ok: true, removed: false }
  if (!markerMatches(marker, plan)) return { ok: false, error: 'the marker does not match this workspace, nothing removed' }

  try {
    if (!opts.force) {
      const s = await inspectWorkspace(plan, git)
      if (s.dirty || s.unpushed) {
        return { ok: false, error: `the workspace has ${s.dirty ? 'uncommitted changes' : ''}${s.dirty && s.unpushed ? ' and ' : ''}${s.unpushed ? 'commits no remote has seen' : ''}; pass force to remove it` }
      }
    }
    if (plan.kind === 'worktree') {
      if (existsSync(plan.path)) await git(['-C', plan.repoPath, 'worktree', 'remove', '--force', plan.path])
      try { await git(['-C', plan.repoPath, 'worktree', 'prune']) } catch { /* best effort */ }
    } else if (existsSync(plan.path)) {
      rmSync(plan.path, { recursive: true, force: true })
    }
    rmSync(plan.markerPath, { force: true })
    return { ok: true, removed: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Every workspace of the project this module has created and not removed. */
export function listWorkspaces(p: ProjectConfig): WorkspaceMarker[] {
  if (!p.workspaceRoot) return []
  const dir = join(p.workspaceRoot, MARKER_DIR, projectSlug(p.name))
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: WorkspaceMarker[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const m = readMarker(join(dir, n))
    if (m) out.push(m)
  }
  return out
}

/** Workspaces whose ticket is no longer active. Reported, never deleted: that is a person's call. */
export function orphanWorkspaces(p: ProjectConfig, activeTickets: Iterable<string>): WorkspaceMarker[] {
  const active = new Set(Array.from(activeTickets, (t) => t.trim()))
  return listWorkspaces(p).filter((m) => !active.has(m.ticket))
}

/** True when the project may open one more workspace. */
export function hasCapacity(p: ProjectConfig): boolean {
  return listWorkspaces(p).length < p.maxParallel
}
