// Moving today's skills into the library (docs/skill-konyvtar.md): copy every skill of the shared skills directory
// into the library, and give each a `global` assignment, so an agent that switches to `skillsMode: composed` gets
// the same skills it has today. Two steps, the way the other tools here work: plan (reads only) and apply.
//
// It COPIES: the shared directory is not touched, so every agent still on `shared` keeps working. It never overwrites
// a skill already in the library, never changes an assignment that exists, and never copies out of the tree: a symlink
// inside a skill is skipped (and reported), because following it could pull in any file the user can read. The top
// entry itself may be a symlink to a skill directory (that is how skills are often installed), it is resolved once.

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isValidSkillName } from './skill-assignments.js'
import { atomicWriteFileSync } from './web/atomic-write.js'

export interface MigrationPlan {
  /** Skills to copy and assign. */
  copy: string[]
  /** Not copied, with the reason (invalid name, no SKILL.md, already in the library, ...). */
  skipped: Array<{ entry: string; reason: string }>
  /** In the library and in the shared directory, but with no assignment: left alone, said out loud. */
  unassigned: string[]
  /** The assignments file cannot be read as JSON: nothing may be written. */
  assignmentsError: string | null
}

export interface MigrationResult {
  copied: string[]
  assigned: string[]
  /** Symlinks and special files inside a skill that were not copied (skill/relative/path). */
  skippedInside: string[]
  failed: Array<{ skill: string; error: string }>
}

function isDirFollowing(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
function isRegularFile(p: string): boolean {
  try { return lstatSync(p).isFile() } catch { return false }
}

function readAssignmentsRaw(path: string): { list: unknown[]; error: string | null; rest: Record<string, unknown> } {
  if (!existsSync(path)) return { list: [], error: null, rest: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { list: [], error: 'the file is not a JSON object', rest: {} }
    const obj = raw as Record<string, unknown>
    const list = obj.assignments
    if (list !== undefined && !Array.isArray(list)) return { list: [], error: '"assignments" is not an array', rest: {} }
    return { list: (list as unknown[] | undefined) ?? [], error: null, rest: obj }
  } catch (err) {
    return { list: [], error: `not valid JSON (${err instanceof Error ? err.message : String(err)})`, rest: {} }
  }
}

export function planSkillMigration(sharedDir: string, libraryDir: string, assignmentsPath: string): MigrationPlan {
  const plan: MigrationPlan = { copy: [], skipped: [], unassigned: [], assignmentsError: null }
  const { list, error } = readAssignmentsRaw(assignmentsPath)
  plan.assignmentsError = error
  const assigned = new Set(list.map((a) => (a && typeof a === 'object' ? (a as { skill?: unknown }).skill : null)).filter((s): s is string => typeof s === 'string'))

  let entries: string[]
  try { entries = readdirSync(sharedDir).sort() } catch { return plan }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const src = join(sharedDir, entry)
    if (!isDirFollowing(src)) { plan.skipped.push({ entry, reason: 'not a directory' }); continue }
    if (!isValidSkillName(entry)) { plan.skipped.push({ entry, reason: 'not a valid skill name' }); continue }
    if (!isRegularFile(join(src, 'SKILL.md'))) { plan.skipped.push({ entry, reason: 'no SKILL.md' }); continue }
    let inLibrary = false
    try { lstatSync(join(libraryDir, entry)); inLibrary = true } catch { inLibrary = false }
    if (inLibrary) {
      plan.skipped.push({ entry, reason: 'already in the library, not overwritten' })
      if (!assigned.has(entry)) plan.unassigned.push(entry)
      continue
    }
    plan.copy.push(entry)
  }
  return plan
}

function copyTree(src: string, dst: string, rel: string, skippedInside: string[]): void {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    const r = rel ? `${rel}/${name}` : name
    const st = lstatSync(s)
    if (st.isDirectory()) copyTree(s, d, r, skippedInside)
    else if (st.isFile()) copyFileSync(s, d)
    else skippedInside.push(r)
  }
}

/** Do the plan. Copies first, then writes the assignments for what was copied (atomically, existing entries kept). */
export function applySkillMigration(plan: MigrationPlan, sharedDir: string, libraryDir: string, assignmentsPath: string): MigrationResult {
  const out: MigrationResult = { copied: [], assigned: [], skippedInside: [], failed: [] }
  if (plan.assignmentsError) return out
  mkdirSync(libraryDir, { recursive: true })
  for (const skill of plan.copy) {
    const inside: string[] = []
    try {
      // a library entry that appeared since the plan is never overwritten
      try { lstatSync(join(libraryDir, skill)); out.failed.push({ skill, error: 'appeared in the library since the plan, not overwritten' }); continue } catch { /* free */ }
      copyTree(join(sharedDir, skill), join(libraryDir, skill), '', inside)
      out.copied.push(skill)
      for (const i of inside) out.skippedInside.push(`${skill}/${i}`)
    } catch (err) {
      // a half-copied skill must not block the next run ("already in the library")
      try { rmSync(join(libraryDir, skill), { recursive: true, force: true }) } catch { /* best effort */ }
      out.failed.push({ skill, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (out.copied.length === 0) return out

  const { list, rest, error } = readAssignmentsRaw(assignmentsPath)
  if (error) { out.failed.push({ skill: '(assignments)', error }); return out }
  const have = new Set(list.map((a) => (a && typeof a === 'object' ? (a as { skill?: unknown }).skill : null)).filter((s): s is string => typeof s === 'string'))
  const added = out.copied.filter((s) => !have.has(s))
  const next = { ...rest, assignments: [...list, ...added.map((skill) => ({ skill, scope: 'global' }))] }
  mkdirSync(join(assignmentsPath, '..'), { recursive: true })
  atomicWriteFileSync(assignmentsPath, JSON.stringify(next, null, 2) + '\n')
  out.assigned = added
  return out
}
