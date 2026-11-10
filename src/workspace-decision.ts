// The dispatch decision tree for a card that moves to in_progress (docs/jegy-kornyezet.md, "Hogyan dönt a dispatch").
// Pure: it takes the project, the ticket, the files the ticket declares it will touch, and the tickets that already
// hold a workspace, and returns what to do. It creates nothing and starts nothing; the caller acts on the answer.
//
// The rules, in order:
//   1. a project that does not isolate tickets -> `shared` (today's behaviour, nothing else is looked at);
//   2. this ticket already holds a workspace -> `existing` (a re-dispatch never makes a second one);
//   3. the project is at its `maxParallel` -> `queued` (capacity);
//   4. nobody else is active -> `new`;
//   5. others are active and every one of them provably touches other files -> `new` (parallel);
//   6. otherwise (overlap, or not known) -> by the project's policy: `queued` (overlap), or `stacked` on the newest
//      conflicting ticket's branch when that branch contains the work of every other conflicting ticket (they form
//      one chain); independent conflicting tickets cannot be contained in one branch, so then it queues.
//      Unknown counts as overlap: the safe side is never "parallel".

import { isolatesTickets, type ProjectConfig } from './projects.js'

/** A ticket that holds a workspace in the project right now. */
export interface ActiveTicket {
  ticket: string
  /** Repo-relative path prefixes the ticket declared. Null or empty: not declared, i.e. unknown. */
  scope: string[] | null
  /** The ticket's own branch. */
  branch: string
  /** The branch it was cut from: the project's base branch, or another ticket's branch when it is stacked. */
  baseBranch: string
  /** ISO time the workspace was created. Decides which ticket is the newest; the input order never does. */
  createdAt: string
}

export interface DecideInput {
  project: ProjectConfig
  ticket: string
  scope: string[] | null
  /** Tickets of this project that hold a workspace (the caller's `listWorkspaces`, joined with their scopes). */
  active: ActiveTicket[]
}

export type WorkspaceDecision =
  | { action: 'shared' }
  | { action: 'existing' }
  | { action: 'new'; baseBranch: string }
  | { action: 'stacked'; onTicket: string; baseBranch: string }
  | { action: 'queued'; reason: 'capacity' | 'overlap'; waitingFor: string[] }

/** Normalise a declared scope to clean repo-relative prefixes, or null when nothing usable was declared. */
export function normalizeScope(scope: unknown): string[] | null {
  if (!Array.isArray(scope)) return null
  const out: string[] = []
  for (const s of scope) {
    if (typeof s !== 'string' || s.includes('\u0000')) continue
    const t = s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    // absolute or escaping paths are not repo-relative: ignore them (and so fall back to "unknown")
    if (t === '' || t.startsWith('/') || t.split('/').includes('..')) continue
    if (!out.includes(t)) out.push(t)
  }
  return out.length > 0 ? out : null
}

// Scope prefixes are always '/'-separated (normalizeScope), whatever the host OS: node:path's separator would be
// wrong on Windows, so the prefix test is done on '/' here and not through pathInside().
function prefixOf(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`)
}

/** Two declared scopes overlap when some prefix of one is the same as, or contains, a prefix of the other. */
export function scopesOverlap(a: string[] | null, b: string[] | null): boolean {
  const sa = normalizeScope(a)
  const sb = normalizeScope(b)
  if (!sa || !sb) return true // unknown on either side
  return sa.some((x) => sb.some((y) => prefixOf(x, y) || prefixOf(y, x)))
}

/** The tickets whose work `t` already contains: the ones it is stacked on, directly or through a chain. */
function ancestorsOf(t: ActiveTicket, all: ActiveTicket[]): Set<string> {
  const seen = new Set<string>()
  let cur: ActiveTicket | undefined = t
  while (cur) {
    const parent: ActiveTicket | undefined = all.find((x) => x.branch === cur!.baseBranch && x.ticket !== cur!.ticket)
    if (!parent || seen.has(parent.ticket)) break
    seen.add(parent.ticket)
    cur = parent
  }
  return seen
}

/** Oldest first; ties broken by ticket id so the order never depends on how the caller listed them. */
function byAge(a: ActiveTicket, b: ActiveTicket): number {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  const d = (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb)
  return d !== 0 ? d : a.ticket.localeCompare(b.ticket)
}

export function decideWorkspace(input: DecideInput): WorkspaceDecision {
  const { project, ticket } = input
  if (!isolatesTickets(project)) return { action: 'shared' }

  const others = input.active.filter((t) => t.ticket !== ticket)
  if (others.length !== input.active.length) return { action: 'existing' }

  if (input.active.length >= project.maxParallel) {
    return { action: 'queued', reason: 'capacity', waitingFor: [...input.active].sort(byAge).map((t) => t.ticket) }
  }

  if (others.length === 0) return { action: 'new', baseBranch: project.baseBranch }

  const conflicting = others.filter((t) => scopesOverlap(input.scope, t.scope))
  if (conflicting.length === 0) return { action: 'new', baseBranch: project.baseBranch }

  const oldestFirst = [...conflicting].sort(byAge)
  if (project.onOverlap === 'stack') {
    // Stack on the newest conflicting ticket, but only when its branch really contains the work of every other
    // conflicting ticket, i.e. they form one chain (each stacked on the one before). Two conflicting tickets that
    // were cut independently cannot both be contained in one branch, so then the ticket waits instead.
    const newest = oldestFirst[oldestFirst.length - 1]
    const contained = ancestorsOf(newest, input.active)
    if (oldestFirst.every((t) => t === newest || contained.has(t.ticket))) {
      return { action: 'stacked', onTicket: newest.ticket, baseBranch: newest.branch }
    }
  }
  return { action: 'queued', reason: 'overlap', waitingFor: oldestFirst.map((t) => t.ticket) }
}
