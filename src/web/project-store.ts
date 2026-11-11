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
// The registry is read on every dispatch and every reconcile pass (once a minute), so what a given text means is
// computed once: the same text returns the same registry without being parsed again, and a problem in it is logged
// once (when the text changes), not once a minute.
const cache = new Map<string, { text: string; registry: ProjectRegistry }>()

export function readProjectRegistry(path: string = PROJECTS_PATH): ProjectRegistry {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    cache.delete(path)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err, path }, 'projects: cannot read the registry, treated as empty')
    return { projects: [], problems: [] }
  }
  const hit = cache.get(path)
  if (hit && hit.text === text) return hit.registry

  let registry: ProjectRegistry
  let raw: unknown
  try {
    raw = JSON.parse(text)
    registry = normalizeProjectRegistry(raw)
    for (const line of registry.problems) logger.warn({ path }, `projects: ${line}`)
  } catch (err) {
    logger.warn({ err, path }, 'projects: registry is not valid JSON, treated as empty')
    registry = { projects: [], problems: [`${path} is not valid JSON`] }
  }
  cache.set(path, { text, registry })
  return registry
}
