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
//   6. otherwise (overlap, or not known) -> by the project's policy: `queued` (overlap) or `stacked` on the other
//      ticket's branch. Unknown counts as overlap: the safe side is never "parallel".

import { isolatesTickets, pathInside, type ProjectConfig } from './projects.js'

/** A ticket that holds a workspace in the project right now. */
export interface ActiveTicket {
  ticket: string
  /** Repo-relative path prefixes the ticket declared. Null or empty: not declared, i.e. unknown. */
  scope: string[] | null
  branch: string
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

/** Two declared scopes overlap when some prefix of one is the same as, or contains, a prefix of the other. */
export function scopesOverlap(a: string[] | null, b: string[] | null): boolean {
  const sa = normalizeScope(a)
  const sb = normalizeScope(b)
  if (!sa || !sb) return true // unknown on either side
  return sa.some((x) => sb.some((y) => pathInside(x, y) || pathInside(y, x)))
}

export function decideWorkspace(input: DecideInput): WorkspaceDecision {
  const { project, ticket } = input
  if (!isolatesTickets(project)) return { action: 'shared' }

  const others = input.active.filter((t) => t.ticket !== ticket)
  if (others.length !== input.active.length) return { action: 'existing' }

  if (input.active.length >= project.maxParallel) {
    return { action: 'queued', reason: 'capacity', waitingFor: input.active.map((t) => t.ticket) }
  }

  if (others.length === 0) return { action: 'new', baseBranch: project.baseBranch }

  const conflicting = others.filter((t) => scopesOverlap(input.scope, t.scope))
  if (conflicting.length === 0) return { action: 'new', baseBranch: project.baseBranch }

  if (project.onOverlap === 'stack') {
    // Stack on the most recently listed conflicting ticket: its branch already contains the earlier ones' work.
    const last = conflicting[conflicting.length - 1]
    return { action: 'stacked', onTicket: last.ticket, baseBranch: last.branch }
  }
  return { action: 'queued', reason: 'overlap', waitingFor: conflicting.map((t) => t.ticket) }
}
