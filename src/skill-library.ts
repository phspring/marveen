// The skill library on disk (docs/skill-konyvtar.md): every skill once, in one directory, and the composition of an
// agent's own skills directory out of symlinks into it. A skill edited in the library is the same file for everyone
// who has it: there is nothing to copy and nothing to keep in step.
//
// composeSkillsDir() turns a target directory into a real directory of symlinks, one per wanted skill. It only ever
// removes what it made itself (a symlink into the library), never a real file or directory. A target that already
// holds entries is reused only when it carries a real marker (a regular file, not a link, holding a JSON object);
// otherwise it is refused and nothing is changed. Entries that are not links into the library are left untouched.
// Nothing calls it yet.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isValidSkillName } from './skill-assignments.js'

export const COMPOSED_MARKER = '.marveen-composed.json'

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

export interface ComposeReport {
  /** Links created or repointed. */
  linked: string[]
  /** Links already right. */
  unchanged: string[]
  /** Stale links this module had made, removed. */
  removed: string[]
  /** Wanted but not given, with the reason (not in the library, a real entry in the way, ...). */
  skipped: Array<{ skill: string; reason: string }>
}

function isRealDir(p: string): boolean {
  try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() } catch { return false }
}

/**
 * The skills in the library: real directories (a symlink in the library is not a skill: it could point anywhere)
 * with a SKILL.md and a valid name, sorted.
 */
export function listLibrarySkills(libraryDir: string): string[] {
  let names: string[]
  try { names = readdirSync(libraryDir) } catch { return [] }
  return names
    .filter((n) => isValidSkillName(n) && isRealDir(join(libraryDir, n)) && existsSync(join(libraryDir, n, 'SKILL.md')))
    .sort()
}

/** A marker counts only when it is a regular file (never a link, which a write would follow) holding a JSON object. */
function isRealMarker(p: string): boolean {
  try {
    if (!lstatSync(p).isFile()) return false
    const v: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch { return false }
}

function linkTarget(link: string): string | null {
  try { return resolve(dirname(link), readlinkSync(link)) } catch { return null }
}

function insideLibrary(p: string, libraryDir: string): boolean {
  const lib = resolve(libraryDir)
  return p === lib || p.startsWith(lib + sep)
}

/**
 * Make `targetDir` a real directory holding exactly the symlinks for `wanted` (names from the library).
 * `replaceLink`: when the target is itself a symlink (the isolated config directory's `skills` entry is one today, a
 * link to the whole shared skills directory), remove THAT LINK (never what it points at) and build the directory in
 * its place.
 */
export function composeSkillsDir(
  libraryDir: string,
  targetDir: string,
  wanted: readonly string[],
  opts: { replaceLink?: boolean } = {},
): Result<{ report: ComposeReport }> {
  if (!isRealDir(libraryDir)) return { ok: false, error: 'the skill library is not a directory' }
  const lib = resolve(libraryDir)
  const target = resolve(targetDir)
  if (target === lib || target.startsWith(lib + sep) || lib.startsWith(target + sep)) {
    return { ok: false, error: 'the target and the library must not contain each other' }
  }

  // the state of the target
  let st: ReturnType<typeof lstatSync> | null = null
  try { st = lstatSync(target) } catch { st = null }
  if (st?.isSymbolicLink()) {
    if (!opts.replaceLink) return { ok: false, error: 'the target is a symlink; it is replaced only when asked to' }
    unlinkSync(target) // the link itself, never what it points at
    st = null
  }
  if (st && !st.isDirectory()) return { ok: false, error: 'the target exists and is not a directory' }
  if (st) {
    const entries = readdirSync(target)
    if (entries.includes(COMPOSED_MARKER) && !isRealMarker(join(target, COMPOSED_MARKER))) {
      return { ok: false, error: 'the composed marker is not a regular JSON file; nothing was changed' }
    }
    if (entries.length > 0 && !entries.includes(COMPOSED_MARKER)) {
      return { ok: false, error: 'the target holds files that this module did not make; nothing was changed' }
    }
  }
  mkdirSync(target, { recursive: true })

  const report: ComposeReport = { linked: [], unchanged: [], removed: [], skipped: [] }
  const inLibrary = new Set(listLibrarySkills(lib))
  const given = new Set<string>()

  for (const skill of [...new Set(wanted)].sort()) {
    if (!isValidSkillName(skill)) { report.skipped.push({ skill: String(skill), reason: 'not a valid skill name' }); continue }
    if (!inLibrary.has(skill)) { report.skipped.push({ skill, reason: 'not in the library' }); continue }
    const link = join(target, skill)
    const want = join(lib, skill)
    let existing: ReturnType<typeof lstatSync> | null = null
    try { existing = lstatSync(link) } catch { existing = null }
    if (existing && !existing.isSymbolicLink()) {
      report.skipped.push({ skill, reason: 'a real file or directory is in the way, left untouched' })
      continue
    }
    if (existing) {
      if (linkTarget(link) === want) { report.unchanged.push(skill); given.add(skill); continue }
      unlinkSync(link)
    }
    symlinkSync(want, link)
    report.linked.push(skill)
    given.add(skill)
  }

  // stale links: only ones this module could have made (a symlink into the library) and no longer wanted
  for (const entry of readdirSync(target)) {
    if (entry === COMPOSED_MARKER || given.has(entry)) continue
    const p = join(target, entry)
    let isLink = false
    try { isLink = lstatSync(p).isSymbolicLink() } catch { isLink = false }
    const to = isLink ? linkTarget(p) : null
    if (isLink && to !== null && insideLibrary(to, lib)) {
      unlinkSync(p)
      report.removed.push(entry)
    }
  }

  const markerPath = join(target, COMPOSED_MARKER)
  try { unlinkSync(markerPath) } catch { /* none yet */ }
  writeFileSync(markerPath, JSON.stringify({ library: lib, skills: [...given].sort(), composedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
  return { ok: true, report }
}
