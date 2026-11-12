// The launcher's side of the skill library (docs/skill-konyvtar.md): who is asking, and what the isolated config
// directory's `skills` entry becomes for an agent that opted in (agent-config.json `skillsMode: "composed"`).
//
//   skillContextFor: the agent (a ticket instance means its template), the project of its work (the instance's
//                    ticket project), and the teams (the agent itself and every leader above it by `reportsTo`).
//   applySkills:     composed mode builds the directory from the library; shared mode leaves today's link alone,
//                    and an agent that goes back to shared gets the composed directory taken down (only what was
//                    made, never a real file) so the shared link can return.
//
// Every effect comes in through `io`, so the rules are tested without an install.

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { composeSkillsDir, listLibrarySkills, releaseComposedDir } from '../skill-library.js'
import { resolveSkillSet, type SkillAssignmentSet, type SkillContext } from '../skill-assignments.js'
import type { InstanceOf } from './agent-instance.js'

export interface SkillCompositionIO {
  libraryDir: string
  assignments: () => SkillAssignmentSet
  /** The ticket-instance marker of the agent, or null for an ordinary agent. */
  instanceOf: (name: string) => InstanceOf | null
  reportsTo: (name: string) => string | null
}

/** The agent itself, then the leaders above it, nearest first; stops at a loop and at a sane depth. */
export function leaderChain(start: string, reportsTo: (n: string) => string | null, maxDepth = 16): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let cur: string | null = start
  while (cur && !seen.has(cur) && chain.length < maxDepth) {
    chain.push(cur)
    seen.add(cur)
    cur = reportsTo(cur)
  }
  return chain
}

export function skillContextFor(name: string, io: Pick<SkillCompositionIO, 'instanceOf' | 'reportsTo'>): SkillContext {
  const inst = io.instanceOf(name)
  // An instance is its template for every rule; its own chain starts at the template, which has the real leaders.
  const agent = inst ? inst.template : name
  return { agent, project: inst?.project ?? null, teams: leaderChain(agent, io.reportsTo) }
}

export type SkillsOutcome =
  | { kind: 'shared' }
  | { kind: 'composed'; skills: string[]; missing: string[]; linked: number; removed: number }
  /** composed was asked for but could not be done: the shared link is left as it was, the reason is logged. */
  | { kind: 'fallback'; why: string }
  /** back to shared, but the composed directory holds something that is not ours: left in place. */
  | { kind: 'kept'; why: string }

/**
 * Bring `<cfg>/skills` in line with the agent's mode. Returns what happened; never throws for an expected state.
 * `mayLinkShared` tells the caller whether it may (re)create the shared link for this entry: false whenever a real
 * directory has to stay (composed, or a composed one holding foreign entries). In SHARED mode with a real directory
 * that is not ours it stays true on purpose: that is today's behaviour of the launcher's entry loop (a stale real copy
 * is replaced by the shared link), and the default mode must not change. Composed mode never replaces a real directory.
 */
export function applySkills(
  cfg: string, name: string, mode: 'shared' | 'composed', io: SkillCompositionIO,
): { outcome: SkillsOutcome; mayLinkShared: boolean } {
  const target = join(cfg, 'skills')
  if (mode === 'shared') {
    const r = releaseComposedDir(io.libraryDir, target)
    if (r.state === 'left') return { outcome: { kind: 'kept', why: `the composed skills directory holds entries that are not links into the library (${r.left.join(', ')})` }, mayLinkShared: false }
    return { outcome: { kind: 'shared' }, mayLinkShared: true }
  }

  const set = io.assignments()
  const resolved = resolveSkillSet(set, skillContextFor(name, io), new Set(listLibrarySkills(io.libraryDir)))
  const r = composeSkillsDir(io.libraryDir, target, resolved.skills.map((s) => s.skill), { replaceLink: true })
  if (!r.ok) {
    // The shared link may come back only where there is nothing real to lose: no entry yet, or a link. A real
    // directory (one of ours with foreign entries, or somebody's) is never replaced.
    let replaceable = true
    try { replaceable = lstatSync(target).isSymbolicLink() } catch { replaceable = true }
    return { outcome: { kind: 'fallback', why: r.error }, mayLinkShared: replaceable }
  }
  return {
    outcome: {
      kind: 'composed', skills: resolved.skills.map((s) => s.skill), missing: resolved.missing,
      linked: r.report.linked.length, removed: r.report.removed.length,
    },
    mayLinkShared: false,
  }
}
