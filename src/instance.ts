// One install is one Nestor instance (docs/nestor-peldany.md). This module says WHAT an instance owns on the machine
// (its port, its service units, its tmux server, its Claude config, its token and database) and finds where two
// instances would share something. Pure of the running system: the .env text, the home directory and the list of
// other instances come in as arguments.
//
// Only a fixed list of .env keys is ever read (never the whole file: it holds secrets), and no value of a secret is
// kept: the token is described by its PATH.

import { join, resolve } from 'node:path'
import { parseEnvContent } from './env-parse.js'

/** The .env keys the instance description reads. Nothing else of the file is looked at. */
export const INSTANCE_ENV_KEYS = [
  'MAIN_AGENT_ID', 'SERVICE_ID', 'WEB_PORT', 'WEB_HOST', 'MAIN_AGENT_ISOLATED_CONFIG', 'TMUX_TMPDIR', 'NESTOR_NODE',
] as const

/** The name a NEW instance gets (`nestor init`). Written into its .env, so it is explicit, never a fallback. */
export const DEFAULT_NEW_INSTANCE_NAME = 'nestor'
/**
 * What the app falls back to when the .env names nothing (src/config.ts MAIN_AGENT_ID). It was "marveen" until
 * every install named itself (nestor init); since then it is "nestor", the same as a new instance's name.
 */
export const APP_FALLBACK_NAME = 'nestor'

export interface InstanceInfo {
  /** The name the service units carry (SERVICE_ID, else MAIN_AGENT_ID): `<unitId>-dashboard`, `<unitId>-channels`. */
  unitId: string
  root: string
  mainAgentId: string
  /** The main agent's tmux session: `<mainAgentId>-channels`. */
  channelsSession: string
  port: number
  host: string
  units: { dashboard: string; channels: string }
  /** Where this instance's tmux server lives: a directory (TMUX_TMPDIR) or `default` (the machine's one server). */
  tmuxServer: string
  /** Where the main agent's Claude config lives: its own directory or the shared ~/.claude. */
  claudeConfig: string
  /** True when the Claude config is the instance's own (not the shared ~/.claude). */
  ownClaudeConfig: boolean
  tokenPath: string
  dbPath: string
  /** The Node binary the launcher uses (NESTOR_NODE), or null for the one on PATH. */
  node: string | null
  /** Which of the instance's own settings its .env states (false: the app falls back to a default for it). */
  explicit: { mainAgentId: boolean; serviceId: boolean; port: boolean }
}

const ID_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())
}

/** Describe the instance installed at `root` from the text of its .env (null: no .env, every default). */
export function describeInstance(root: string, envText: string | null, home: string): InstanceInfo {
  const env = envText === null ? {} : parseEnvContent(envText, [...INSTANCE_ENV_KEYS])
  const r = resolve(root)
  const hasMain = ID_RX.test(env.MAIN_AGENT_ID ?? '')
  const hasService = ID_RX.test(env.SERVICE_ID ?? '')
  const main = hasMain ? env.MAIN_AGENT_ID : APP_FALLBACK_NAME
  const unitId = hasService ? env.SERVICE_ID : main
  const portRaw = parseInt(env.WEB_PORT ?? '3420', 10)
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3420
  const own = truthy(env.MAIN_AGENT_ISOLATED_CONFIG)
  const tmuxDir = (env.TMUX_TMPDIR ?? '').trim()
  return {
    unitId,
    root: r,
    mainAgentId: main,
    channelsSession: `${main}-channels`,
    port,
    host: env.WEB_HOST?.trim() || '127.0.0.1',
    units: { dashboard: `${unitId}-dashboard`, channels: `${unitId}-channels` },
    tmuxServer: tmuxDir ? resolve(tmuxDir) : 'default',
    claudeConfig: own ? join(r, '.channels-config') : join(home, '.claude'),
    ownClaudeConfig: own,
    tokenPath: join(r, 'store', '.claude-oauth-token'),
    dbPath: join(r, 'store', 'claudeclaw.db'),
    node: env.NESTOR_NODE?.trim() || null,
    explicit: { mainAgentId: hasMain, serviceId: hasService, port: Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 && env.WEB_PORT !== undefined },
  }
}

/** What is wrong with the instance on its own (not between two): settings it leaves to a default. */
export function selfWarnings(i: InstanceInfo): string[] {
  const w: string[] = []
  if (!i.explicit.mainAgentId) w.push(`MAIN_AGENT_ID is not set in .env: the main agent is called "${APP_FALLBACK_NAME}" by default. Name it (nestor init, or MAIN_AGENT_ID=...).`)
  if (!i.explicit.serviceId) w.push(`SERVICE_ID is not set in .env: the service units are called ${i.units.dashboard} / ${i.units.channels} after the main agent.`)
  if (!i.explicit.port) w.push(`WEB_PORT is not set in .env: the dashboard uses ${i.port}, which any other install without a port shares.`)
  return w
}

/** The first port from 3420 up that none of `taken` uses. */
export function nextFreePort(taken: readonly number[], from = 3420): number {
  const t = new Set(taken)
  let p = from
  while (t.has(p) && p < 65535) p++
  return p
}

export interface Conflict {
  /** `error`: the two cannot run side by side. `warn`: they can, but they will step on each other. */
  level: 'error' | 'warn'
  between: [string, string]
  what: string
  detail: string
}

/**
 * Every place where `a` and `b` share something they should each own. Symmetric: call it once per pair.
 * errors: same install directory, same port (on the same host), same service-unit name.
 * warnings: the same tmux server with the same channels session name (a collision), the same tmux server at all
 * (agent sessions are named after the agent, so same-named agents of the two instances would collide), and the same
 * Claude config directory (skills, hooks and plugin state in one place).
 */
export function findConflicts(a: InstanceInfo, b: InstanceInfo): Conflict[] {
  const out: Conflict[] = []
  const between: [string, string] = [a.unitId, b.unitId]
  const push = (level: Conflict['level'], what: string, detail: string) => out.push({ level, between, what, detail })

  if (a.root === b.root) {
    push('error', 'install directory', `both live in ${a.root}`)
    return out // everything else follows from it
  }
  if (a.port === b.port && a.host === b.host) push('error', 'port', `both listen on ${a.host}:${a.port}`)
  if (a.unitId === b.unitId) push('error', 'service units', `both are named ${a.unitId}-* (${a.units.dashboard}, ${a.units.channels})`)

  if (a.tmuxServer === b.tmuxServer) {
    const where = a.tmuxServer === 'default' ? "the machine's default tmux server" : `the tmux server in ${a.tmuxServer}`
    if (a.channelsSession === b.channelsSession) {
      push('warn', 'tmux session', `both use the session "${a.channelsSession}" on ${where}`)
    }
    push('warn', 'tmux server', `both run their agents on ${where}; agent sessions are named after the agent, so same-named agents collide`)
  }
  if (a.claudeConfig === b.claudeConfig) {
    push('warn', 'Claude config', `both use ${a.claudeConfig}: its settings, skills and plugin state are one`)
  }
  return out
}

/** All conflicts of `self` with each of `others` (an entry with the same root as `self` is the same instance: skipped). */
export function conflictsWithOthers(self: InstanceInfo, others: readonly InstanceInfo[]): Conflict[] {
  const out: Conflict[] = []
  for (const o of others) {
    if (o.root === self.root) continue
    out.push(...findConflicts(self, o))
  }
  return out
}
