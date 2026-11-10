// Ticket instances: an ephemeral, REAL agent made from a template agent, one per ticket (docs/jegy-kornyezet.md).
//
// Why a real agent and not a new kind of session: the launcher, the message router, the kanban dispatch, the status
// and the dashboard all key on an agent NAME (agentSessionName() is used in ~34 places, isAgentRunning() in ~42). An
// instance that is a real agent directory runs through all of them unchanged, and the card's `assignee` is simply
// the instance name.
//
// What is copied and what is linked:
//   copied   CLAUDE.md, SOUL.md, .mcp.json, .claude/settings.json, .claude/agents/*: the launcher REWRITES these in
//            place at every start (ensure*Section, the profile settings write), so a symlink would write through into
//            the template. They are small and per-agent by nature.
//   linked   the template's own .claude/skills/* entries: read-only content that must not be duplicated (one skill,
//            one source, updated once).
//   fresh    memory/ (empty): the instance does not write into the template's memory.
//
// Nothing calls this yet. Removal refuses anything that is not an instance made here, and anything still running.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import { safeJoin, sanitizeAgentName } from './sanitize.js'
import { ticketSlug } from './workspace.js'

/** What marks an agent directory as an instance, in its agent-config.json. */
export interface InstanceOf {
  template: string
  ticket: string
  project: string | null
  /** The workspace the instance works in (a literal absolute path the dispatch message also carries). */
  workspace: string | null
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

const MAX_NAME = 50 // sanitizeAgentName cuts at 50
const MACHINE_SPECIFIC_CONFIG_KEYS = ['remoteHost', 'remoteWorkdir', 'claudeConfigDir', 'oauthTokenFile'] as const
const INSTANCE_BEGIN = '<!-- INSTANCE-BEGIN -->'
const INSTANCE_END = '<!-- INSTANCE-END -->'

/**
 * The agent name of a ticket instance: `<template>-<ticket>`, passed through sanitizeAgentName so it survives every
 * API that re-sanitizes (lower case, single hyphens, at most 50 characters). A name that would be cut gets a short
 * hash of the exact (template, ticket) pair so two different long tickets never collide. Null for unusable input.
 */
export function instanceName(template: string, ticket: unknown): string | null {
  const slug = ticketSlug(ticket)
  if (!slug) return null
  const t = sanitizeAgentName(template)
  const s = sanitizeAgentName(slug)
  if (!t || !s) return null
  const plain = `${t}-${s}`
  if (plain.length <= MAX_NAME) return sanitizeAgentName(plain) === plain ? plain : null
  const hash = createHash('sha256').update(`${template}\u0000${slug}`).digest('hex').slice(0, 6)
  // keep the ticket tail (the number is what people recognise), shorten the template first
  const room = MAX_NAME - hash.length - 1
  const tail = s.slice(-Math.min(s.length, 20))
  const head = `${t}-`.slice(0, Math.max(1, room - tail.length - 1)).replace(/-+$/, '')
  const name = sanitizeAgentName(`${head}-${tail}-${hash}`.slice(0, MAX_NAME))
  return name || null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/** The instance marker of an agent directory, or null when it is an ordinary agent. */
export function readInstanceOf(dir: string): InstanceOf | null {
  const cfg = readJson(join(dir, 'agent-config.json'))
  const m = cfg?.instanceOf as Partial<InstanceOf> | undefined
  if (!m || typeof m.template !== 'string' || typeof m.ticket !== 'string') return null
  return {
    template: m.template,
    ticket: m.ticket,
    project: typeof m.project === 'string' ? m.project : null,
    workspace: typeof m.workspace === 'string' ? m.workspace : null,
  }
}

function instanceSection(i: InstanceOf): string {
  return [
    INSTANCE_BEGIN,
    '## Jegy-példány',
    '',
    `Ez egy ideiglenes példány a(z) \`${i.template}\` sablonból, a(z) \`${i.ticket}\` jegyre${i.project ? ` (projekt: ${i.project})` : ''}.`,
    i.workspace
      ? `A jegy munkakönyvtára: \`${i.workspace}\`. Gitet csak literális abszolút úttal használj: \`git -C ${i.workspace} …\`, változóval vagy \`$(…)\`-vel nem. Ide dolgozz, a fő checkoutba nem.`
      : 'Ehhez a jegyhez nincs külön munkakönyvtár: a projekt közös checkoutján dolgozol, a megbízás szerint.',
    'Nem commitolsz és nem pusholsz, azt a vezető vagy a fő session végzi. A jegy lezárásakor ez a példány megszűnik, ezért ami megmaradjon, azt a jegy kommentjébe vagy a vezetőnek írd.',
    INSTANCE_END,
  ].join('\n')
}

function withInstanceSection(claudeMd: string, i: InstanceOf): string {
  const block = instanceSection(i)
  const rx = new RegExp(`${INSTANCE_BEGIN}[\\s\\S]*?${INSTANCE_END}`)
  return rx.test(claudeMd) ? claudeMd.replace(rx, () => block) : `${claudeMd.trimEnd()}\n\n${block}\n`
}

/**
 * Create the instance directory of `template` for `ticket` under `base` (the agents directory).
 * Idempotent: the same (template, ticket) returns the existing instance; anything else under that name is refused.
 */
export function createAgentInstance(
  base: string,
  template: string,
  ticket: unknown,
  opts: { project?: string | null; workspace?: string | null; reservedIds?: readonly string[] } = {},
): Result<{ name: string; dir: string; created: boolean }> {
  // A template is a real agent, and real agent names are always in sanitized form. Anything else (a path, a name with
  // dots or capitals) is refused here, as an error value: safeJoin would only throw on it.
  if (typeof template !== 'string' || template === '' || sanitizeAgentName(template) !== template) {
    return { ok: false, error: 'invalid template name' }
  }
  const name = instanceName(template, ticket)
  if (!name) return { ok: false, error: 'invalid ticket id or template name' }
  if ((opts.reservedIds ?? []).includes(name) || (opts.reservedIds ?? []).includes(template)) {
    return { ok: false, error: 'the name is a reserved agent id' }
  }

  let tplDir: string
  let dir: string
  try {
    tplDir = safeJoin(base, template)
    dir = safeJoin(base, name)
  } catch {
    return { ok: false, error: 'invalid agent name' }
  }
  if (!existsSync(join(tplDir, 'agent-config.json')) || !existsSync(join(tplDir, 'CLAUDE.md'))) {
    return { ok: false, error: `template "${template}" does not exist or is incomplete` }
  }
  if (readInstanceOf(tplDir)) return { ok: false, error: 'an instance cannot be a template' }

  // The template's config carries the model, the security profile and the team: an instance built without it would
  // run on defaults, so an unreadable config is an error, checked BEFORE anything is created.
  const tplConfig = readJson(join(tplDir, 'agent-config.json'))
  if (!tplConfig) return { ok: false, error: `the config of template "${template}" is not a readable JSON object` }

  const marker: InstanceOf = {
    template, ticket: ticketSlug(ticket) as string, project: opts.project ?? null, workspace: opts.workspace ?? null,
  }
  if (existsSync(dir)) {
    const existing = readInstanceOf(dir)
    if (existing && existing.template === template && existing.ticket === marker.ticket) return { ok: true, name, dir, created: false }
    return { ok: false, error: `an agent named "${name}" already exists and is not this instance` }
  }

  try {
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'MEMORY.md'), '')

    // copied: the launcher rewrites these in place
    const claudeMd = readFileSync(join(tplDir, 'CLAUDE.md'), 'utf-8')
    atomicWriteFileSync(join(dir, 'CLAUDE.md'), withInstanceSection(claudeMd, marker))
    for (const f of ['SOUL.md', '.mcp.json']) {
      if (existsSync(join(tplDir, f))) copyFileSync(join(tplDir, f), join(dir, f))
    }
    if (existsSync(join(tplDir, '.claude', 'settings.json'))) {
      copyFileSync(join(tplDir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.json'))
    }
    const agentsDir = join(tplDir, '.claude', 'agents')
    if (existsSync(agentsDir)) {
      for (const f of readdirSync(agentsDir)) {
        const src = join(agentsDir, f)
        if (lstatSync(src).isFile()) copyFileSync(src, join(dir, '.claude', 'agents', f))
      }
    }

    // linked: the template's own skills, one source
    const skillsDir = join(tplDir, '.claude', 'skills')
    if (existsSync(skillsDir)) {
      for (const f of readdirSync(skillsDir)) {
        if (f.startsWith('.')) continue
        symlinkSync(join(skillsDir, f), join(dir, '.claude', 'skills', f))
      }
    }

    // the config: the template's, without anything machine-specific, marked as an instance
    const cfg = { ...tplConfig }
    for (const k of MACHINE_SPECIFIC_CONFIG_KEYS) delete cfg[k]
    const tplTeam = (cfg.team && typeof cfg.team === 'object' ? cfg.team : {}) as { reportsTo?: unknown; trustFrom?: unknown }
    cfg.team = {
      role: 'member',
      reportsTo: typeof tplTeam.reportsTo === 'string' ? tplTeam.reportsTo : null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: Array.isArray(tplTeam.trustFrom) ? tplTeam.trustFrom.filter((x): x is string => typeof x === 'string') : [],
    }
    const baseName = typeof cfg.displayName === 'string' && cfg.displayName ? cfg.displayName : template
    cfg.displayName = `${baseName} · ${marker.ticket}`
    cfg.instanceOf = marker
    atomicWriteFileSync(join(dir, 'agent-config.json'), JSON.stringify(cfg, null, 2))
    return { ok: true, name, dir, created: true }
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Instances currently on disk under `base`, with the marker that says what each one is for. */
export function listAgentInstances(base: string): Array<{ name: string; of: InstanceOf }> {
  let names: string[]
  try { names = readdirSync(base) } catch { return [] }
  const out: Array<{ name: string; of: InstanceOf }> = []
  for (const n of names) {
    const of = readInstanceOf(join(base, n))
    if (of) out.push({ name: n, of })
  }
  return out
}

/**
 * Delete an instance. Refuses anything that is not an instance (so a typo can never remove a real agent) and
 * anything whose session is still up: the caller stops it first.
 */
export function removeAgentInstance(base: string, name: string, deps: { isRunning: (name: string) => boolean }): Result<{ removed: boolean }> {
  let dir: string
  try { dir = safeJoin(base, name) } catch { return { ok: false, error: 'invalid agent name' } }
  if (!existsSync(dir)) return { ok: true, removed: false }
  if (!readInstanceOf(dir)) return { ok: false, error: `"${name}" is not an instance, nothing removed` }
  if (deps.isRunning(name)) return { ok: false, error: `"${name}" is still running, stop it first` }
  try {
    // symlinks (the linked skills) are removed as links, never followed
    rmSync(dir, { recursive: true, force: true })
    return { ok: true, removed: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
