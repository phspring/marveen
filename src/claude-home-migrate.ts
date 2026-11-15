// `nestor migrate-claude-home`: give an existing install its OWN Claude home (src/claude-home.ts), once.
//
// Builds created before the instance home ran every agent on the host user's ~/.claude (directly, or through config
// dirs whose entries were links into it). This copies, ONCE, what the instance needs to keep working into its own
// home, and cuts the old links. After it the instance never reads the host again.
//
// Copied (each only when the host has it, never overwriting what the home already has):
//   skills/, agents/, scheduled-tasks/, tools/      what the fleet used as its shared library
//   plugins/                                        the channel plugins (cache, marketplaces, data, registries)
//   settings.json                                   without hooks / disableAllHooks (the fleet hooks are project scope)
//   .claude.json                                    onboarding/theme flags, the user-scope MCP servers, and the
//                                                   projects entries of THIS install's dirs only
//   projects/<this install's dirs>                  the agents' transcripts and auto-memory
// NOT copied, on purpose:
//   .credentials.json   copying a rotating login splits its refresh chain and logs one side out; the home needs its
//                       own login (`CLAUDE_CONFIG_DIR=<home> claude auth login`) or the fleet setup-token
//   CLAUDE.md           the host user's personal instructions are not the bots'
//   history, sessions, caches, logs, other installs' projects, channels (install-scoped already, #915)
// The host ~/.claude is only READ: nothing in it is changed or deleted.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { CLAUDE_HOME_MARKER, instanceClaudeHome, sweepHostLinkEntries } from './claude-home.js'
import { encodeClaudeProjectDir } from './claude-project-dir.js'

export type MigrateResult = { home: string; already: boolean; copied: string[]; skipped: string[]; unlinked: string[]; notes: string[] }

const COPY_DIRS = ['skills', 'agents', 'scheduled-tasks', 'tools', 'plugins'] as const
const DOT_CLAUDE_KEEP = ['hasCompletedOnboarding', 'theme', 'mcpServers', 'bypassPermissionsModeAccepted', 'hasAcknowledgedCostThreshold'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readJson(p: string): unknown {
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return undefined }
}

/** The settings.json the home starts from: the host's minus what must never ride a copy. */
export function homeSettingsFrom(host: unknown): Record<string, unknown> {
  const s = isPlainObject(host) ? { ...host } : {}
  delete s.hooks
  delete s.disableAllHooks
  return s
}

/** The .claude.json the home starts from: the flags that keep the first-run dialogs away, the user-scope MCP servers,
 *  and only the projects entries under `root` (another install's or the operator's own projects are not ours). */
export function homeDotClaudeFrom(host: unknown, root: string): Record<string, unknown> {
  const out: Record<string, unknown> = { hasCompletedOnboarding: true }
  if (!isPlainObject(host)) return out
  for (const k of DOT_CLAUDE_KEEP) if (k in host) out[k] = host[k]
  out.hasCompletedOnboarding = true
  if (isPlainObject(host.projects)) {
    const mine: Record<string, unknown> = {}
    for (const [p, v] of Object.entries(host.projects)) if (p === root || p.startsWith(root + sep)) mine[p] = v
    out.projects = mine
  }
  return out
}

/** The config dirs this install provisions: the main agent's, each agent's, and the workers' inside the home. */
export function installConfigDirs(root: string, home: string): string[] {
  const dirs = [join(root, '.channels-config')]
  try {
    for (const a of readdirSync(join(root, 'agents'))) dirs.push(join(root, 'agents', a, '.claude-config'))
  } catch { /* no agents */ }
  try {
    for (const w of readdirSync(join(home, 'workers'))) dirs.push(join(home, 'workers', w, '.claude-config'))
  } catch { /* no workers yet */ }
  return dirs.filter((d) => existsSync(d))
}

/** Copy `src` to `dst` following every link (cpSync's `dereference` only covers the top level, measured on Node 24:
 *  a nested link stayed a link). Modes kept. A dangling link is skipped; depth is bounded against link cycles. */
export function copyTreeDeref(src: string, dst: string, depth = 0): void {
  if (depth > 32) return
  let st
  try { st = statSync(src) } catch { return }
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true, mode: st.mode & 0o777 })
    for (const e of readdirSync(src)) copyTreeDeref(join(src, e), join(dst, e), depth + 1)
  } else if (st.isFile()) {
    copyFileSync(src, dst)
    chmodSync(dst, st.mode & 0o777)
  }
}

export function migrateClaudeHome(root: string, opts: { hostHome?: string; dryRun?: boolean; home?: string } = {}): MigrateResult {
  const hostHome = opts.hostHome ?? homedir()
  const host = join(hostHome, '.claude')
  const home = opts.home ?? instanceClaudeHome(root)
  const r: MigrateResult = { home, already: false, copied: [], skipped: [], unlinked: [], notes: [] }
  const marker = join(home, CLAUDE_HOME_MARKER)
  if (existsSync(marker)) {
    r.already = true
  } else {
    if (!opts.dryRun) {
      mkdirSync(home, { recursive: true })
      chmodSync(home, 0o700)
    }
    const copy = (src: string, rel: string) => {
      const dst = join(home, rel)
      if (!existsSync(src)) return
      if (existsSync(dst)) { r.skipped.push(`${rel} (already in the home)`); return }
      // Links are copied as their content: a link inside the host tree must not become a link back into it.
      if (!opts.dryRun) copyTreeDeref(src, dst)
      r.copied.push(rel)
    }
    for (const d of COPY_DIRS) copy(join(host, d), d)

    const settingsDst = join(home, 'settings.json')
    if (!existsSync(settingsDst)) {
      if (!opts.dryRun) writeFileSync(settingsDst, JSON.stringify(homeSettingsFrom(readJson(join(host, 'settings.json'))), null, 2) + '\n', { mode: 0o600 })
      r.copied.push('settings.json (no hooks)')
    }
    const dotDst = join(home, '.claude.json')
    if (!existsSync(dotDst)) {
      if (!opts.dryRun) writeFileSync(dotDst, JSON.stringify(homeDotClaudeFrom(readJson(join(hostHome, '.claude.json')), root), null, 2) + '\n', { mode: 0o600 })
      r.copied.push('.claude.json (flags, MCP servers, this install\'s projects)')
    }
    // This install's transcripts and auto-memory: the encoded dirs of the root and everything under it.
    const prefix = encodeClaudeProjectDir(root)
    try {
      for (const p of readdirSync(join(host, 'projects'))) {
        if (p === prefix || p.startsWith(prefix + '-')) copy(join(host, 'projects', p), join('projects', p))
      }
    } catch { /* no host projects */ }

    if (!opts.dryRun) writeFileSync(marker, JSON.stringify({ root, createdAt: new Date().toISOString(), importedFrom: existsSync(host) ? host : null }, null, 2) + '\n')
    r.copied.push(CLAUDE_HOME_MARKER)
  }

  // Cut the old links: every provisioned dir loses its links into the host; the next agent start relinks into the home.
  for (const d of installConfigDirs(root, home)) {
    for (const sub of [d, join(d, 'plugins')]) {
      if (opts.dryRun) {
        try {
          for (const e of readdirSync(sub)) {
            try { if (lstatSync(join(sub, e)).isSymbolicLink()) r.unlinked.push(`${join(sub, e)} (if it leads into the host)`) } catch { /* gone */ }
          }
        } catch { /* absent */ }
      } else {
        for (const e of sweepHostLinkEntries(sub, hostHome)) r.unlinked.push(join(sub, e))
      }
    }
  }
  if (!existsSync(join(root, 'store', '.claude-oauth-token')) && !existsSync(join(home, '.credentials.json'))) {
    r.notes.push(`no fleet setup-token and no login in the home: log the home in once with  CLAUDE_CONFIG_DIR=${home} claude auth login  (or store a setup-token in store/.claude-oauth-token)`)
  }
  r.notes.push('restart the services (nestor restart) so every agent comes up on the home')
  return r
}

export function renderMigrate(r: MigrateResult, dryRun: boolean): string {
  const lines = [`${dryRun ? '[dry run] ' : ''}instance Claude home: ${r.home}${r.already ? ' (already there; only the links are checked)' : ''}`]
  for (const c of r.copied) lines.push(`  ${dryRun ? 'would copy' : 'copied'}: ${c}`)
  for (const s of r.skipped) lines.push(`  kept: ${s}`)
  for (const u of r.unlinked) lines.push(`  ${dryRun ? 'would unlink' : 'unlinked'}: ${u}`)
  for (const n of r.notes) lines.push(`  next: ${n}`)
  return lines.join('\n')
}
