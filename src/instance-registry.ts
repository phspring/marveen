// The machine's list of Nestor instances (docs/nestor-peldany.md): one small file per install in
// `~/.config/nestor/instances/`, holding only WHERE the install is. What an instance owns is read from its own .env
// every time (describeInstance), so the list can never go stale about a port or a unit name; it can only go stale
// about an install that was deleted, which is reported and skipped.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describeInstance, type InstanceInfo } from './instance.js'

export function registryDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.NESTOR_REGISTRY_DIR) return resolve(env.NESTOR_REGISTRY_DIR)
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'nestor', 'instances')
}

/** One file per install directory, named by a hash of the path: two installs with the same name never share a file. */
function entryPath(dir: string, root: string): string {
  return join(dir, `${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)}.json`)
}

export function registerInstance(dir: string, root: string, now: Date = new Date()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(entryPath(dir, root), JSON.stringify({ root: resolve(root), registeredAt: now.toISOString() }, null, 2) + '\n')
}

export function unregisterInstance(dir: string, root: string): boolean {
  const p = entryPath(dir, root)
  if (!existsSync(p)) return false
  rmSync(p)
  return true
}

export interface RegistryRead {
  instances: InstanceInfo[]
  /** Registered installs whose directory is gone (not an instance any more). */
  stale: string[]
  /** Files that could not be read as an entry. */
  unreadable: string[]
}

function readEnvText(root: string): string | null {
  try { return readFileSync(join(root, '.env'), 'utf-8') } catch { return null }
}

export function readRegistry(dir: string, home: string): RegistryRead {
  const out: RegistryRead = { instances: [], stale: [], unreadable: [] }
  let names: string[]
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return out }
  for (const n of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, n), 'utf-8')) as { root?: unknown }
      if (typeof raw.root !== 'string' || !raw.root) { out.unreadable.push(n); continue }
      if (!existsSync(raw.root)) { out.stale.push(raw.root); continue }
      out.instances.push(describeInstance(raw.root, readEnvText(raw.root), home))
    } catch { out.unreadable.push(n) }
  }
  return out
}

export function describeInstallAt(root: string, home: string): InstanceInfo {
  return describeInstance(root, readEnvText(root), home)
}
