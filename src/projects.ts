// Project registry: which repo a kanban project is, how its tickets are isolated, and how a card finds its project.
// Pure and I/O-free (the file read lives in web/project-store.ts), so the rules are unit-tested without a disk.
//
// Nothing calls this yet. A project is `shared` (today's behaviour: one checkout, one session per agent) unless the
// operator sets `mode: "worktree"` AND names a `workspaceRoot`. Every invalid or incomplete entry falls back to
// `shared` or is dropped, never to something that isolates less safely than it says (see docs/jegy-kornyezet.md).
//
// DELIBERATELY NOT HERE: setup/teardown commands. The dashboard would run them, and store/projects.json is writable
// by any agent running as the same OS user, so a command field would be an auto-exec path for a compromised agent.
// It comes only after the file is on the db-write-gate's protected list (owner's call, GATE follow-up).

import { isAbsolute, normalize, sep } from 'node:path'

export type ProjectMode = 'shared' | 'worktree'
/** `plain`: an ordinary repo (isolated with `git worktree`). `submodule`: a repo whose main checkout is a
 *  submodule (isolated with a self-contained clone; a linked worktree of a submodule inherits `core.worktree`). */
export type RepoKind = 'plain' | 'submodule'
export type ResolveVia = 'card' | 'jira' | 'directory'

export interface ProjectConfig {
  /** Equals the kanban card's `project` text (matched case-insensitively). */
  name: string
  repoPath: string
  repoKind: RepoKind
  mode: ProjectMode
  baseBranch: string
  /** Jira project keys (e.g. "TVR") whose tickets belong here. */
  jiraKeys: string[]
  /** Absolute, outside the repo. Required for `worktree` mode. */
  workspaceRoot: string | null
  /** At most this many tickets of the project hold a workspace at once. */
  maxParallel: number
  /** What a ticket does when another active ticket of the project may touch the same files: wait for it to close,
   *  or stack its branch on the other ticket's branch. */
  onOverlap: OverlapPolicy
}

export type OverlapPolicy = 'wait' | 'stack'

export interface ProjectRegistry {
  projects: ProjectConfig[]
  /** One line per dropped or downgraded entry, for the log and the dashboard. */
  problems: string[]
}

export const DEFAULT_BASE_BRANCH = 'develop'
export const DEFAULT_MAX_PARALLEL = 2
export const MAX_PARALLEL_LIMIT = 32

const NAME_RX = /^[^\u0000-\u001f\u007f]{1,100}$/u
const BRANCH_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/
const JIRA_KEY_RX = /^[A-Z][A-Z0-9]{1,9}$/
const JIRA_REF_RX = /^([A-Z][A-Z0-9]{1,9})-\d+$/

export function isSafeBranchName(b: unknown): b is string {
  return typeof b === 'string' && BRANCH_RX.test(b)
    && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock')
    && !b.split('/').some((seg) => seg === '' || seg.startsWith('.') || seg.endsWith('.lock'))
}

function cleanAbsolutePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.includes('\u0000')) return null
  const t = p.trim()
  if (!isAbsolute(t)) return null
  const n = normalize(t).replace(/[\\/]+$/, '')
  return n === '' ? null : n
}

/** `inner` is `outer` or below it, on a path boundary (so /a/bc is not inside /a/b). */
export function pathInside(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer + sep)
}

/** Normalise the raw store/projects.json value. Never throws; bad entries are reported in `problems`. */
export function normalizeProjectRegistry(raw: unknown): ProjectRegistry {
  const out: ProjectConfig[] = []
  const problems: string[] = []
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { projects?: unknown }).projects
    : undefined
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return { projects: out, problems }

  const seenNames = new Set<string>()
  const seenKeys = new Map<string, string>()

  for (const [rawName, rawEntry] of Object.entries(entries as Record<string, unknown>)) {
    const name = rawName.trim()
    if (!NAME_RX.test(name)) { problems.push(`project "${rawName}": invalid name, dropped`); continue }
    if (seenNames.has(name.toLowerCase())) { problems.push(`project "${name}": duplicate name, dropped`); continue }
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      problems.push(`project "${name}": entry is not an object, dropped`); continue
    }
    const e = rawEntry as Record<string, unknown>

    const repoPath = cleanAbsolutePath(e.repoPath)
    if (!repoPath) { problems.push(`project "${name}": repoPath must be an absolute path, dropped`); continue }

    const repoKind: RepoKind = e.repoKind === 'submodule' ? 'submodule' : 'plain'
    if (e.repoKind !== undefined && e.repoKind !== 'plain' && e.repoKind !== 'submodule') {
      problems.push(`project "${name}": unknown repoKind, treated as plain`)
    }

    let baseBranch = DEFAULT_BASE_BRANCH
    if (e.baseBranch !== undefined) {
      if (isSafeBranchName(e.baseBranch)) baseBranch = e.baseBranch
      else problems.push(`project "${name}": invalid baseBranch, using ${DEFAULT_BASE_BRANCH}`)
    }

    const jiraKeys: string[] = []
    if (e.jiraKeys !== undefined) {
      if (!Array.isArray(e.jiraKeys)) problems.push(`project "${name}": jiraKeys must be a list, ignored`)
      else {
        for (const k of e.jiraKeys) {
          const key = typeof k === 'string' ? k.trim().toUpperCase() : ''
          if (!JIRA_KEY_RX.test(key)) { problems.push(`project "${name}": invalid Jira key ${JSON.stringify(k)}, ignored`); continue }
          const owner = seenKeys.get(key)
          if (owner && owner !== name) { problems.push(`project "${name}": Jira key ${key} already belongs to "${owner}", ignored`); continue }
          if (!jiraKeys.includes(key)) jiraKeys.push(key)
        }
      }
    }

    let workspaceRoot: string | null = null
    if (e.workspaceRoot !== undefined) {
      const root = cleanAbsolutePath(e.workspaceRoot)
      if (!root) problems.push(`project "${name}": workspaceRoot must be an absolute path, ignored`)
      else if (pathInside(root, repoPath) || pathInside(repoPath, root)) {
        problems.push(`project "${name}": workspaceRoot and repoPath must not contain each other, ignored`)
      } else workspaceRoot = root
    }

    let mode: ProjectMode = 'shared'
    if (e.mode === 'worktree') {
      if (workspaceRoot) mode = 'worktree'
      else problems.push(`project "${name}": mode worktree needs a valid workspaceRoot, kept shared`)
    } else if (e.mode !== undefined && e.mode !== 'shared') {
      problems.push(`project "${name}": unknown mode, kept shared`)
    }

    let maxParallel = DEFAULT_MAX_PARALLEL
    if (e.maxParallel !== undefined) {
      const n = e.maxParallel
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PARALLEL_LIMIT) maxParallel = n
      else problems.push(`project "${name}": maxParallel must be an integer 1..${MAX_PARALLEL_LIMIT}, using ${DEFAULT_MAX_PARALLEL}`)
    }

    let onOverlap: OverlapPolicy = 'wait'
    if (e.onOverlap === 'stack') onOverlap = 'stack'
    else if (e.onOverlap !== undefined && e.onOverlap !== 'wait') {
      problems.push(`project "${name}": unknown onOverlap, using wait`)
    }

    seenNames.add(name.toLowerCase())
    for (const k of jiraKeys) seenKeys.set(k, name)
    out.push({ name, repoPath, repoKind, mode, baseBranch, jiraKeys, workspaceRoot, maxParallel, onOverlap })
  }
  return { projects: out, problems }
}

/** "TVR-2658" -> "TVR". Null for anything that is not a Jira-style issue key. */
export function jiraKeyOf(ref: string | null | undefined): string | null {
  const m = JIRA_REF_RX.exec((ref ?? '').trim().toUpperCase())
  return m ? m[1] : null
}

export interface ResolveInput {
  /** The kanban card's `project` text. */
  project?: string | null
  /** The card's external reference, e.g. "TVR-2658". */
  externalRef?: string | null
  /** Where an agent is working. */
  cwd?: string | null
}

export interface ResolvedProject {
  project: ProjectConfig
  via: ResolveVia
}

/**
 * Who owns this card. Fixed order (docs/jegy-kornyezet.md):
 *  1. the card's own `project` text. When it is set it is final: an unknown name resolves to nothing, it does not
 *     fall through to the Jira key (the card said which project it is);
 *  2. the Jira key prefix of `externalRef`;
 *  3. the directory: the registered repo that contains `cwd` (the longest repoPath wins).
 * Null means "not in the registry": the caller keeps today's shared behaviour.
 */
export function resolveProject(input: ResolveInput, registry: ProjectRegistry): ResolvedProject | null {
  const wanted = (input.project ?? '').trim().toLowerCase()
  if (wanted) {
    const p = registry.projects.find((x) => x.name.toLowerCase() === wanted)
    return p ? { project: p, via: 'card' } : null
  }

  const key = jiraKeyOf(input.externalRef)
  if (key) {
    const p = registry.projects.find((x) => x.jiraKeys.includes(key))
    if (p) return { project: p, via: 'jira' }
  }

  const cwd = cleanAbsolutePath(input.cwd)
  if (cwd) {
    let best: ProjectConfig | null = null
    for (const p of registry.projects) {
      if (pathInside(cwd, p.repoPath) && (!best || p.repoPath.length > best.repoPath.length)) best = p
    }
    if (best) return { project: best, via: 'directory' }
  }
  return null
}

/** True when a card of this project gets its own workspace. Everything else is today's shared checkout. */
export function isolatesTickets(p: ProjectConfig): boolean {
  return p.mode === 'worktree' && p.workspaceRoot !== null
}
