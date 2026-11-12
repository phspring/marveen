import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { normalizeSkillAssignments, type SkillAssignmentSet } from '../skill-assignments.js'

export const SKILL_ASSIGNMENTS_PATH = join(PROJECT_ROOT, 'store', 'skill-assignments.json')
export const SKILL_LIBRARY_DIR = join(PROJECT_ROOT, 'store', 'skill-library')

// Read on every agent start, so what a given text means is computed once: the same text returns the same set without
// being parsed again, and a problem in it is logged once (when the text changes), not on every start.
const cache = new Map<string, { text: string; set: SkillAssignmentSet }>()

/**
 * Read store/skill-assignments.json. A missing file is the normal, empty state (nothing is assigned). An unreadable or
 * malformed file is also empty, with one warning: a broken file must never hand out skills by accident.
 */
export function readSkillAssignments(path: string = SKILL_ASSIGNMENTS_PATH): SkillAssignmentSet {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    cache.delete(path)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err, path }, 'skills: cannot read the assignments, treated as empty')
    return { assignments: [], problems: [] }
  }
  const hit = cache.get(path)
  if (hit && hit.text === text) return hit.set

  let set: SkillAssignmentSet
  try {
    set = normalizeSkillAssignments(JSON.parse(text))
    for (const line of set.problems) logger.warn({ path }, `skills: ${line}`)
  } catch (err) {
    logger.warn({ err, path }, 'skills: the assignments are not valid JSON, treated as empty')
    set = { assignments: [], problems: [`${path} is not valid JSON`] }
  }
  cache.set(path, { text, set })
  return set
}
