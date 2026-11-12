// The Projects page: the board's per-project summary (what the cards say) joined with what store/projects.json
// says about the same project (how it is registered). Pure: the summary, the registry and the count of live
// workspaces come in as arguments, so the join can be tested without a database or a disk.
//
// Matching is by name, case-insensitively, the way a card's `project` text meets a registry entry everywhere else
// (resolveProject). A registered project with no live card is still listed (with zero cards): without that, a
// project that was just registered, or whose cards are all archived, could not be seen anywhere in the dashboard.

import { isolatesTickets, type ProjectConfig, type ProjectMode, type ProjectRegistry } from './projects.js'

/** What the page shows about a registration. Deliberately the repo's name and not its full path (see repoName). */
export interface ProjectRegistration {
  mode: ProjectMode
  /** The last segment of repoPath: enough to recognise the repo, without publishing the host's directory layout. */
  repo: string
  baseBranch: string
  maxParallel: number
  /** True when a card of this project gets its own workspace (worktree mode with a workspaceRoot). */
  isolated: boolean
  /** Tickets of this project that hold a workspace right now; null when the project is not isolated. */
  activeTickets: number | null
}

/** The summary fields this join reads and passes through (a KanbanProjectSummary satisfies this). */
export interface OverviewBase {
  project: string
  cardTotal: number
  cardDone: number
  lastActivityAt: number | null
  activeAssignees: string[]
  description: string | null
  descriptionUpdatedAt: number | null
}

export type ProjectOverview<T extends OverviewBase = OverviewBase> = T & {
  /** Null: the project is not in the registry, so it behaves as `shared` (today's single checkout). */
  registration: ProjectRegistration | null
}

/** The repository's directory name. Never the whole path: that is the host's layout, which the page does not need. */
export function repoName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : repoPath
}

function registrationOf(p: ProjectConfig, activeTickets: (p: ProjectConfig) => number): ProjectRegistration {
  const isolated = isolatesTickets(p)
  return {
    mode: p.mode,
    repo: repoName(p.repoPath),
    baseBranch: p.baseBranch,
    maxParallel: p.maxParallel,
    isolated,
    activeTickets: isolated ? activeTickets(p) : null,
  }
}

/**
 * Join the board summaries with the registry. The result is the summaries (in their order, each with its
 * `registration` or null) followed by the registered projects that have no summary (alphabetical, zero cards).
 */
export function joinProjectOverview<T extends OverviewBase>(
  summaries: readonly T[],
  registry: ProjectRegistry,
  activeTickets: (p: ProjectConfig) => number,
  /** The stored description of a project that has no card (so it is not in the summaries); null when none. */
  describe: (name: string) => { description: string; updatedAt: number | null } | null = () => null,
): Array<ProjectOverview<T> | ProjectOverview<OverviewBase>> {
  const byName = new Map<string, ProjectConfig>()
  for (const p of registry.projects) byName.set(p.name.toLowerCase(), p)

  const seen = new Set<string>()
  const out: Array<ProjectOverview<T> | ProjectOverview<OverviewBase>> = summaries.map((s) => {
    const p = byName.get(s.project.toLowerCase())
    if (p) seen.add(p.name.toLowerCase())
    return { ...s, registration: p ? registrationOf(p, activeTickets) : null }
  })

  const extra = registry.projects
    .filter((p) => !seen.has(p.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const p of extra) {
    const d = describe(p.name)
    out.push({
      project: p.name, cardTotal: 0, cardDone: 0, lastActivityAt: null, activeAssignees: [],
      description: d?.description ? d.description : null, descriptionUpdatedAt: d?.updatedAt ?? null,
      registration: registrationOf(p, activeTickets),
    })
  }
  return out
}
