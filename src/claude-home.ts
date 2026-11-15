// The instance's own Claude home (docs/sajat-claude-home.md).
//
// Every nestor instance runs on ONE host user next to other instances and next to the user's own Claude Code. The
// fleet used to treat the host user's `~/.claude` as its shared root: every isolated config dir (the main agent's
// `.channels-config`, each `agents/<n>/.claude-config`) linked skills, agents, CLAUDE.md, scheduled-tasks, history,
// channels ... into it, and the skill installers wrote there. So a skill one instance's bot installed showed up in
// every other instance and in the operator's personal Claude, and the operator's personal CLAUDE.md reached the bots.
//
// The rule now: an instance uses ONLY its own home. Nothing an instance provisions may resolve into the host
// `~/.claude`, and there is no silent fallback to it: no home -> the caller refuses (NoInstanceHomeError).
//
// Resolution, read at call time (tests and the launchers can point it elsewhere):
//   1. NESTOR_CLAUDE_HOME in the environment (the launcher / test seam)
//   2. NESTOR_CLAUDE_HOME in the install's .env
//   3. <install root>/.claude-home
// `<install root>/.claude` is NOT a candidate: that is the project scope Claude Code loads by cwd (the fleet hooks).

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { parseEnvContent } from './env-parse.js'

export const CLAUDE_HOME_MARKER = '.nestor-claude-home'
export const DEFAULT_CLAUDE_HOME_NAME = '.claude-home'

export class NoInstanceHomeError extends Error {
  constructor(readonly home: string, why: string) {
    super(`the instance has no own Claude home at ${home} (${why}); run \`nestor migrate-claude-home\``)
    this.name = 'NoInstanceHomeError'
  }
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

/** True when `p` is the host user's ~/.claude (or ~/.claude.json), the home dir itself, or anything inside ~/.claude. */
export function isInHostClaude(p: string, home: string = homedir()): boolean {
  const host = real(join(home, '.claude'))
  const rp = real(p)
  return rp === host || rp.startsWith(host + sep) || rp === real(join(home, '.claude.json')) || rp === real(home)
}

function readEnvAt(root: string): Record<string, string> {
  try { return parseEnvContent(readFileSync(join(root, '.env'), 'utf-8'), ['NESTOR_CLAUDE_HOME']) } catch { return {} }
}

function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/** The instance's Claude home path (it may not exist yet). Throws on a value that points into the host ~/.claude. */
export function instanceClaudeHome(root: string = PROJECT_ROOT): string {
  const fromProcess = process.env.NESTOR_CLAUDE_HOME?.trim()
  // CLAUDECLAW_ENV_DIR: the same test-only redirect of the install .env that src/env.ts honours.
  const envRoot = root === PROJECT_ROOT ? (process.env.CLAUDECLAW_ENV_DIR ?? PROJECT_ROOT) : root
  const fromEnvFile = readEnvAt(envRoot).NESTOR_CLAUDE_HOME?.trim()
  return claudeHomeFrom(root, fromProcess || fromEnvFile)
}

/** The home for `root` given a NESTOR_CLAUDE_HOME value (or none): the same rule, without reading anything. */
export function claudeHomeFrom(root: string, value?: string): string {
  const raw = value?.trim() || join(root, DEFAULT_CLAUDE_HOME_NAME)
  const expanded = expandHome(raw)
  // Relative is refused, not resolved against the cwd: the shell twin (scripts/lib/claude-home.sh) refuses it too.
  if (!isAbsolute(expanded)) throw new Error(`NESTOR_CLAUDE_HOME must be an absolute path: ${raw}`)
  const p = resolve(expanded)
  if (isInHostClaude(p)) {
    throw new Error(`NESTOR_CLAUDE_HOME must not be the host user's ~/.claude, its home dir, or inside it: ${p}`)
  }
  return p
}

/** True when the instance home exists as a directory and carries the marker `nestor migrate-claude-home` writes. */
export function hasInstanceClaudeHome(home: string = instanceClaudeHome()): boolean {
  try {
    return statSync(home).isDirectory() && statSync(join(home, CLAUDE_HOME_MARKER)).isFile()
  } catch {
    return false
  }
}

/** The instance home, or NoInstanceHomeError. Every provisioner calls this: there is no fallback to the host. */
export function requireInstanceClaudeHome(home: string = instanceClaudeHome()): string {
  if (!existsSync(home)) throw new NoInstanceHomeError(home, 'missing')
  if (!hasInstanceClaudeHome(home)) throw new NoInstanceHomeError(home, `no ${CLAUDE_HOME_MARKER} marker`)
  return home
}

/** The marker's content: which install the home belongs to (a home copied to another install is noticed). */
export function readClaudeHomeMarker(home: string): { root?: string } | null {
  try {
    const v = JSON.parse(readFileSync(join(home, CLAUDE_HOME_MARKER), 'utf-8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as { root?: string }) : null
  } catch {
    return null
  }
}

// The fleet-shared parts of the home. Each is the instance's own copy of what used to be ~/.claude/<x>.
export const instanceSkillsDir = (home: string = instanceClaudeHome()) => join(home, 'skills')
export const instanceScheduledTasksDir = (home: string = instanceClaudeHome()) => join(home, 'scheduled-tasks')
export const instancePluginsDir = (home: string = instanceClaudeHome()) => join(home, 'plugins')
export const instanceSettingsPath = (home: string = instanceClaudeHome()) => join(home, 'settings.json')
export const instanceDotClaudeJson = (home: string = instanceClaudeHome()) => join(home, '.claude.json')

/** Remove every symlink directly in `dir` whose target resolves into the host user's ~/.claude (only the link, never
 *  what it points at). Returns the removed names. */
export function sweepHostLinkEntries(dir: string, home: string = homedir()): string[] {
  const removed: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return removed }
  for (const entry of entries) {
    const p = join(dir, entry)
    try {
      if (!lstatSync(p).isSymbolicLink()) continue
      if (isInHostClaude(resolve(dirname(p), readlinkSync(p)), home)) {
        // unlink, not rmSync: rmSync refuses a link to a directory without `recursive`, and `recursive` is not
        // something to hand a path that leads into the host tree.
        unlinkSync(p)
        removed.push(entry)
      }
    } catch { /* vanished meanwhile */ }
  }
  return removed
}

/** The worker's home inside the instance home (was ~/.<id>-worker[-fast], shared by same-named instances). */
export const instanceWorkerHome = (agentId: string, variant: 'slow' | 'fast', home: string = instanceClaudeHome()) =>
  join(home, 'workers', `${agentId}${variant === 'fast' ? '-fast' : ''}`)
