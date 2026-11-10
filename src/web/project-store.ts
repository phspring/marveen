import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { normalizeProjectRegistry, type ProjectRegistry } from '../projects.js'

export const PROJECTS_PATH = join(PROJECT_ROOT, 'store', 'projects.json')

/**
 * Read store/projects.json. A missing file is the normal, empty state (every project stays `shared`, i.e. today's
 * behaviour). An unreadable or malformed file is also empty, with one warning: a broken registry must never turn
 * isolation on by accident.
 */
export function readProjectRegistry(path: string = PROJECTS_PATH): ProjectRegistry {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err, path }, 'projects: cannot read the registry, treated as empty')
    return { projects: [], problems: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    logger.warn({ err, path }, 'projects: registry is not valid JSON, treated as empty')
    return { projects: [], problems: [`${path} is not valid JSON`] }
  }
  const registry = normalizeProjectRegistry(raw)
  for (const line of registry.problems) logger.warn({ path }, `projects: ${line}`)
  return registry
}
