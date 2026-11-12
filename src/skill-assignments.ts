// Skill assignments: which skill of the library a given agent gets (docs/skill-konyvtar.md). Pure and I/O-free (the
// file read lives in web/skill-assignments-store.ts), so the rules are unit-tested without a disk.
//
// One library holds every skill once; an assignment says WHO gets it, at one of five scopes, from the widest to the
// most specific:
//
//   global         everyone
//   project        everyone working in a project (an instance: the project of its ticket)
//   team           every agent under a leader (the leader's `reportsTo` chain)
//   agent          one agent (an instance counts as its TEMPLATE)
//   agent-project  one agent in one project only
//
// Resolution, per skill: of the assignments that apply to the context, the MOST SPECIFIC one decides; and an
// `exclude` beats an `include` at the same scope (the safe side: a skill nobody can be sure about is left out).
// So a skill can be given to everyone and taken away from one agent, or given to one agent in one project only.

import { sanitizeSkillName } from './web/sanitize.js'

export type SkillScope = 'global' | 'project' | 'team' | 'agent' | 'agent-project'
export type SkillMode = 'include' | 'exclude'

/** Higher is more specific, and wins. */
export const SCOPE_LEVEL: Readonly<Record<SkillScope, number>> = {
  global: 1, project: 2, team: 3, agent: 4, 'agent-project': 5,
}

export interface SkillAssignment {
  skill: string
  scope: SkillScope
  mode: SkillMode
  /** For `project` and `agent-project`. Matched case-insensitively, like the card's project text. */
  project: string | null
  /** For `team`: the leader's agent id. */
  team: string | null
  /** For `agent` and `agent-project`: the agent id (a template, for an instance). */
  agent: string | null
}

export interface SkillAssignmentSet {
  assignments: SkillAssignment[]
  /** One line per dropped entry, for the log and the dashboard. */
  problems: string[]
}

/** Who is asking: the agent (a template, for an instance), the project of its work, and the leaders above it. */
export interface SkillContext {
  agent: string | null
  project: string | null
  teams: readonly string[]
}

export interface ResolvedSkills {
  /** The skills to give, sorted by name, each with the scope that decided it. */
  skills: Array<{ skill: string; via: SkillScope }>
  /** Assigned to this context but absent from the library: reported, never silently ignored. */
  missing: string[]
}

const SCOPES = Object.keys(SCOPE_LEVEL) as SkillScope[]
const ID_RX = /^[a-z0-9-]{1,50}$/
const PROJECT_RX = /^[^\u0000-\u001f\u007f]{1,100}$/u

export function isValidSkillName(n: unknown): n is string {
  return typeof n === 'string' && n !== '' && sanitizeSkillName(n) === n
}

function key(a: SkillAssignment): string {
  return [a.skill, a.scope, (a.project ?? '').toLowerCase(), a.team ?? '', a.agent ?? ''].join('\u0000')
}

/** Normalise the raw store/skill-assignments.json value. Never throws; bad entries are reported in `problems`. */
export function normalizeSkillAssignments(raw: unknown): SkillAssignmentSet {
  const problems: string[] = []
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { assignments?: unknown }).assignments : undefined
  if (!Array.isArray(list)) return { assignments: [], problems }

  const byKey = new Map<string, SkillAssignment>()
  list.forEach((entry, i) => {
    const at = `assignment #${i + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`${at}: not an object, dropped`); return }
    const e = entry as Record<string, unknown>

    if (!isValidSkillName(e.skill)) { problems.push(`${at}: invalid skill name, dropped`); return }
    if (typeof e.scope !== 'string' || !SCOPES.includes(e.scope as SkillScope)) { problems.push(`${at} (${e.skill}): unknown scope, dropped`); return }
    const scope = e.scope as SkillScope
    if (e.mode !== undefined && e.mode !== 'include' && e.mode !== 'exclude') { problems.push(`${at} (${e.skill}): unknown mode, dropped`); return }
    const mode: SkillMode = e.mode === 'exclude' ? 'exclude' : 'include'

    const needsProject = scope === 'project' || scope === 'agent-project'
    const needsTeam = scope === 'team'
    const needsAgent = scope === 'agent' || scope === 'agent-project'

    let project: string | null = null
    let team: string | null = null
    let agent: string | null = null
    if (needsProject) {
      project = typeof e.project === 'string' ? e.project.trim() : ''
      if (!PROJECT_RX.test(project)) { problems.push(`${at} (${e.skill}): scope ${scope} needs a project, dropped`); return }
    }
    if (needsTeam) {
      team = typeof e.team === 'string' ? e.team.trim() : ''
      if (!ID_RX.test(team)) { problems.push(`${at} (${e.skill}): scope team needs a leader id, dropped`); return }
    }
    if (needsAgent) {
      agent = typeof e.agent === 'string' ? e.agent.trim() : ''
      if (!ID_RX.test(agent)) { problems.push(`${at} (${e.skill}): scope ${scope} needs an agent id, dropped`); return }
    }

    const a: SkillAssignment = { skill: e.skill, scope, mode, project, team, agent }
    const k = key(a)
    const prev = byKey.get(k)
    if (prev) {
      // the same assignment twice: if they disagree, exclude wins (the safe side), and it is said
      if (prev.mode !== a.mode) {
        problems.push(`${at} (${e.skill}): the same ${scope} assignment is both include and exclude, exclude kept`)
        if (a.mode === 'exclude') byKey.set(k, a)
      }
      return
    }
    byKey.set(k, a)
  })
  return { assignments: [...byKey.values()], problems }
}

function applies(a: SkillAssignment, ctx: SkillContext): boolean {
  const sameProject = a.project !== null && ctx.project !== null && a.project.toLowerCase() === ctx.project.trim().toLowerCase()
  switch (a.scope) {
    case 'global': return true
    case 'project': return sameProject
    case 'team': return a.team !== null && ctx.teams.includes(a.team)
    case 'agent': return a.agent !== null && a.agent === ctx.agent
    case 'agent-project': return a.agent !== null && a.agent === ctx.agent && sameProject
  }
}

/**
 * The skills `ctx` gets. `library` is the set of skills that actually exist in the library: an assigned skill that is
 * not in it is listed in `missing` and not given.
 */
export function resolveSkillSet(set: SkillAssignmentSet, ctx: SkillContext, library: ReadonlySet<string>): ResolvedSkills {
  const decided = new Map<string, SkillAssignment>()
  for (const a of set.assignments) {
    if (!applies(a, ctx)) continue
    const cur = decided.get(a.skill)
    if (!cur || SCOPE_LEVEL[a.scope] > SCOPE_LEVEL[cur.scope] || (SCOPE_LEVEL[a.scope] === SCOPE_LEVEL[cur.scope] && a.mode === 'exclude')) {
      decided.set(a.skill, a)
    }
  }
  const skills: ResolvedSkills['skills'] = []
  const missing: string[] = []
  for (const a of decided.values()) {
    if (a.mode !== 'include') continue
    if (library.has(a.skill)) skills.push({ skill: a.skill, via: a.scope })
    else missing.push(a.skill)
  }
  skills.sort((x, y) => x.skill.localeCompare(y.skill))
  missing.sort()
  return { skills, missing }
}
