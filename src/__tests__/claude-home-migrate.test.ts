// `nestor migrate-claude-home` (src/claude-home-migrate.ts): what an existing install takes along into its own home,
// what it never takes, that the host is only read, and that a second run changes nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateClaudeHome, homeDotClaudeFrom, homeSettingsFrom } from '../claude-home-migrate.js'

let S = ''
const hostHome = () => join(S, 'host')
const host = () => join(S, 'host', '.claude')
const root = () => join(S, 'install')
const home = () => join(S, 'install', '.claude-home')

function enc(p: string) { return p.replace(/[^a-zA-Z0-9-]/g, '-') }

function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      out.push(`${p}:${st.isFile() ? readFileSync(p, 'utf-8') : st.isSymbolicLink() ? 'link' : 'dir'}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

beforeEach(() => {
  S = mkdtempSync(join(tmpdir(), 'chmigrate-'))
  delete process.env.NESTOR_CLAUDE_HOME
  for (const d of ['skills/a', 'agents', 'scheduled-tasks/t', 'tools/x', 'plugins/cache/p', 'channels/telegram', 'sessions']) mkdirSync(join(host(), d), { recursive: true })
  writeFileSync(join(host(), 'skills', 'a', 'SKILL.md'), 'a\n')
  writeFileSync(join(host(), 'plugins', 'installed_plugins.json'), '{"plugins":{}}')
  writeFileSync(join(host(), 'CLAUDE.md'), 'personal\n')
  writeFileSync(join(host(), '.credentials.json'), '{"secret":true}')
  writeFileSync(join(host(), 'history.jsonl'), '{}\n')
  writeFileSync(join(host(), 'channels', 'telegram', '.env'), 'TOKEN=x\n')
  writeFileSync(join(host(), 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, disableAllHooks: true, model: 'opus' }))
  mkdirSync(root(), { recursive: true })
  writeFileSync(join(hostHome(), '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', mcpServers: { mail: {} }, oauthAccount: { email: 'x' },
    projects: { [root()]: { hasTrustDialogAccepted: true }, [join(root(), 'agents', 'a')]: { t: 1 }, '/elsewhere': { t: 2 }, [root() + '-other']: { t: 3 } },
  }))
  for (const p of [enc(root()), enc(join(root(), 'agents', 'a')), enc('/elsewhere'), enc(root() + '-other').replace(/-other$/, 'X')]) {
    mkdirSync(join(host(), 'projects', p), { recursive: true })
    writeFileSync(join(host(), 'projects', p, 's.jsonl'), p)
  }
  // an existing config dir of this install, linked into the host the old way
  mkdirSync(join(root(), '.channels-config', 'plugins'), { recursive: true })
  symlinkSync(join(host(), 'skills'), join(root(), '.channels-config', 'skills'))
  symlinkSync(join(host(), 'CLAUDE.md'), join(root(), '.channels-config', 'CLAUDE.md'))
  symlinkSync(join(host(), 'plugins', 'cache'), join(root(), '.channels-config', 'plugins', 'cache'))
})
afterEach(() => { rmSync(S, { recursive: true, force: true }) })

describe('migrateClaudeHome', () => {
  it('copies the shared library, plugins, cleaned settings and this install\'s projects; never the login, CLAUDE.md or history', () => {
    const before = snapshot(host())
    const r = migrateClaudeHome(root(), { hostHome: hostHome(), home: home() })
    expect(r.already).toBe(false)
    expect(readFileSync(join(home(), 'skills', 'a', 'SKILL.md'), 'utf-8')).toBe('a\n')
    for (const d of ['agents', 'scheduled-tasks', 'tools', 'plugins']) expect(existsSync(join(home(), d)), d).toBe(true)
    expect(existsSync(join(home(), '.credentials.json'))).toBe(false)
    expect(existsSync(join(home(), 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(home(), 'history.jsonl'))).toBe(false)
    expect(existsSync(join(home(), 'channels'))).toBe(false)
    expect(existsSync(join(home(), 'sessions'))).toBe(false)
    const settings = JSON.parse(readFileSync(join(home(), 'settings.json'), 'utf-8'))
    expect(settings).toEqual({ model: 'opus' })
    const dot = JSON.parse(readFileSync(join(home(), '.claude.json'), 'utf-8'))
    expect(dot.oauthAccount).toBeUndefined()
    expect(dot.mcpServers).toEqual({ mail: {} })
    expect(Object.keys(dot.projects).sort()).toEqual([root(), join(root(), 'agents', 'a')].sort())
    expect(readdirSync(join(home(), 'projects')).sort()).toEqual([enc(root()), enc(join(root(), 'agents', 'a'))].sort())
    expect(existsSync(join(home(), '.nestor-claude-home'))).toBe(true)
    // the host was only read
    expect(snapshot(host())).toEqual(before)
    // the old links are cut
    expect(existsSync(join(root(), '.channels-config', 'skills'))).toBe(false)
    expect(existsSync(join(root(), '.channels-config', 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(root(), '.channels-config', 'plugins', 'cache'))).toBe(false)
    expect(r.notes.join('\n')).toContain('claude auth login')
  })

  it('a link inside a copied host tree is copied as content, never as a link back into the host', () => {
    symlinkSync(join(host(), 'skills', 'a'), join(host(), 'skills', 'linked'))
    migrateClaudeHome(root(), { hostHome: hostHome(), home: home() })
    expect(lstatSync(join(home(), 'skills', 'linked')).isSymbolicLink()).toBe(false)
  })

  it('a second run changes nothing, and never overwrites what the home already has', () => {
    migrateClaudeHome(root(), { hostHome: hostHome(), home: home() })
    writeFileSync(join(home(), 'skills', 'a', 'SKILL.md'), 'edited in the home\n')
    const r = migrateClaudeHome(root(), { hostHome: hostHome(), home: home() })
    expect(r.already).toBe(true)
    expect(r.copied).toEqual([])
    expect(readFileSync(join(home(), 'skills', 'a', 'SKILL.md'), 'utf-8')).toBe('edited in the home\n')
  })

  it('--dry-run writes nothing anywhere', () => {
    const r = migrateClaudeHome(root(), { hostHome: hostHome(), home: home(), dryRun: true })
    expect(existsSync(home())).toBe(false)
    expect(r.copied).toContain('skills')
    expect(lstatSync(join(root(), '.channels-config', 'skills')).isSymbolicLink()).toBe(true)
  })

  it('with a fleet token there is no login note', () => {
    mkdirSync(join(root(), 'store'), { recursive: true })
    writeFileSync(join(root(), 'store', '.claude-oauth-token'), 'tok')
    expect(migrateClaudeHome(root(), { hostHome: hostHome(), home: home() }).notes.join('\n')).not.toContain('auth login')
  })
})

describe('the starting files', () => {
  it('settings: hooks and disableAllHooks never ride along', () => {
    expect(homeSettingsFrom({ hooks: {}, disableAllHooks: true, a: 1 })).toEqual({ a: 1 })
    expect(homeSettingsFrom(null)).toEqual({})
  })
  it('.claude.json: onboarding is always set; an unreadable host file still gives a usable one', () => {
    expect(homeDotClaudeFrom(undefined, '/r')).toEqual({ hasCompletedOnboarding: true })
    expect(homeDotClaudeFrom({ hasCompletedOnboarding: false }, '/r').hasCompletedOnboarding).toBe(true)
  })
})
