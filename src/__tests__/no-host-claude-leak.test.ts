// The guard for docs/sajat-claude-home.md: an instance uses ONLY its own Claude home. Nothing the provisioners build
// may resolve into the host user's ~/.claude, the host tree is never written, and without an instance home there is
// no provisioning at all (no silent fallback to the host).
//
// The fake host ~/.claude carries every entry the old provisioner linked (skills, agents, CLAUDE.md, channels with a
// bot token, history, scheduled-tasks, plugins) plus a settings.json and ~/.claude.json, so a leak of any kind shows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { useInstanceHome } from './helpers/instance-home.js'

let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'host') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name), readAgentAuthMode: () => 'shared' }
})

const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')
const { isInHostClaude, instanceClaudeHome, requireInstanceClaudeHome, NoInstanceHomeError } = await import('../claude-home.js')

const host = () => join(SANDBOX, 'host', '.claude')

function seedHost() {
  const h = host()
  for (const d of ['skills/host-only', 'agents', 'scheduled-tasks/t', 'channels/telegram', 'plugins/cache', 'plugins/marketplaces', 'plugins/data', 'tools', 'sessions']) {
    mkdirSync(join(h, d), { recursive: true })
  }
  writeFileSync(join(h, 'skills', 'host-only', 'SKILL.md'), 'host\n')
  writeFileSync(join(h, 'CLAUDE.md'), 'the operator\'s personal instructions\n')
  writeFileSync(join(h, 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=host-token\n')
  writeFileSync(join(h, 'history.jsonl'), '{}\n')
  writeFileSync(join(h, 'settings.json'), JSON.stringify({ env: { HOST_ONLY: '1' } }))
  writeFileSync(join(h, '.credentials.json'), '{"host":true}')
  writeFileSync(join(SANDBOX, 'host', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, hostOnly: true }))
}

function seedInstanceHome(dir: string) {
  for (const d of ['skills/inst-skill', 'plugins/cache', 'plugins/marketplaces', 'plugins/data']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'skills', 'inst-skill', 'SKILL.md'), 'inst\n')
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { INST: '1' } }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
}

/** Every path under `dir` (links not followed), with where it really leads. */
function walk(dir: string, out: Array<{ p: string; real: string }> = []): Array<{ p: string; real: string }> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    let real = p
    try { real = realpathSync(p) } catch { /* dangling */ }
    out.push({ p, real })
    if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) walk(p, out)
  }
  return out
}

function snapshot(dir: string): string {
  return walk(dir).map(({ p }) => {
    const st = lstatSync(p)
    return `${p}:${st.isFile() ? readFileSync(p, 'utf-8') : st.isSymbolicLink() ? 'link' : 'dir'}:${st.mtimeMs}`
  }).sort().join('\n')
}

let restore: () => void = () => {}
beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'nohostleak-'))
  seedHost()
  mkdirSync(join(SANDBOX, 'agents', 'probe'), { recursive: true })
})
afterEach(() => {
  restore()
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('no instance config dir leads into the host ~/.claude', () => {
  it('a provisioned agent dir: every entry resolves inside the instance (home or the dir itself), the host tree is untouched', () => {
    const inst = join(SANDBOX, 'inst-home')
    restore = useInstanceHome(inst)
    seedInstanceHome(inst)
    const before = snapshot(host())
    const cfg = ensureIsolatedChannelConfigDir('probe', 'telegram')
    expect(cfg).toBe(join(SANDBOX, 'agents', 'probe', '.claude-config'))
    const hostReal = realpathSync(host())
    const leaks = walk(cfg!).filter(({ real }) => real === hostReal || real.startsWith(hostReal + sep))
    expect(leaks).toEqual([])
    // the instance's own skill is there, the host's is not
    expect(existsSync(join(cfg!, 'skills', 'inst-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cfg!, 'skills', 'host-only'))).toBe(false)
    expect(existsSync(join(cfg!, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(cfg!, 'history.jsonl'))).toBe(false)
    // settings come from the instance home, not the host
    const settings = JSON.parse(readFileSync(join(cfg!, 'settings.json'), 'utf-8'))
    expect(settings.env).toEqual({ INST: '1' })
    // the consent file is the dir's own real file, seeded from the instance home, never a link to a shared one
    expect(lstatSync(join(cfg!, '.claude.json')).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(join(cfg!, '.claude.json'), 'utf-8')).hostOnly).toBeUndefined()
    expect(snapshot(host())).toBe(before)
  })

  it('an existing dir from an older build: its links into the host are cut, only the links (the host keeps everything)', () => {
    const inst = join(SANDBOX, 'inst-home')
    restore = useInstanceHome(inst)
    seedInstanceHome(inst)
    const cfg = join(SANDBOX, 'agents', 'probe', '.claude-config')
    mkdirSync(join(cfg, 'plugins'), { recursive: true })
    for (const e of ['CLAUDE.md', 'channels', 'history.jsonl', 'skills', 'agents']) symlinkSync(join(host(), e), join(cfg, e))
    symlinkSync(join(host(), 'plugins', 'cache'), join(cfg, 'plugins', 'cache'))
    symlinkSync(join(SANDBOX, 'host', '.claude.json'), join(cfg, '.claude.json'))
    const before = snapshot(host())
    ensureIsolatedChannelConfigDir('probe', 'telegram')
    const hostReal = realpathSync(host())
    const leaks = walk(cfg).filter(({ real }) => real === hostReal || real.startsWith(hostReal + sep) || real === realpathSync(join(SANDBOX, 'host', '.claude.json')))
    expect(leaks).toEqual([])
    expect(snapshot(host())).toBe(before)
    expect(readFileSync(join(SANDBOX, 'host', '.claude.json'), 'utf-8')).toContain('hostOnly')
  })

  it('no instance home: nothing is provisioned (no fallback to the host) and nothing is created', () => {
    process.env.NESTOR_CLAUDE_HOME = join(SANDBOX, 'missing-home')
    restore = () => { delete process.env.NESTOR_CLAUDE_HOME }
    expect(ensureIsolatedChannelConfigDir('probe', 'telegram')).toBeNull()
    expect(existsSync(join(SANDBOX, 'agents', 'probe', '.claude-config'))).toBe(false)
    expect(existsSync(join(SANDBOX, 'missing-home'))).toBe(false)
    expect(() => requireInstanceClaudeHome()).toThrow(NoInstanceHomeError)
  })

  it('a home dir without the marker is not a home', () => {
    mkdirSync(join(SANDBOX, 'unmarked'), { recursive: true })
    process.env.NESTOR_CLAUDE_HOME = join(SANDBOX, 'unmarked')
    restore = () => { delete process.env.NESTOR_CLAUDE_HOME }
    expect(ensureIsolatedChannelConfigDir('probe', 'telegram')).toBeNull()
  })
})

describe('instanceClaudeHome: where the home is, and what it may never be', () => {
  afterEach(() => { delete process.env.NESTOR_CLAUDE_HOME })

  it('refuses the host ~/.claude, anything inside it, the home dir itself and a relative path', () => {
    for (const bad of [host(), join(host(), 'nested'), join(SANDBOX, 'host'), '~/.claude', 'relative/home']) {
      process.env.NESTOR_CLAUDE_HOME = bad
      expect(() => instanceClaudeHome(), bad).toThrow()
    }
  })

  it('refuses a link that leads into the host ~/.claude', () => {
    symlinkSync(host(), join(SANDBOX, 'sneaky'))
    process.env.NESTOR_CLAUDE_HOME = join(SANDBOX, 'sneaky')
    expect(() => instanceClaudeHome()).toThrow()
    expect(isInHostClaude(join(SANDBOX, 'sneaky'))).toBe(true)
  })

  it('env wins over the install .env, which wins over <root>/.claude-home', () => {
    const root = join(SANDBOX, 'install')
    mkdirSync(root, { recursive: true })
    expect(instanceClaudeHome(root)).toBe(join(root, '.claude-home'))
    writeFileSync(join(root, '.env'), `NESTOR_CLAUDE_HOME="${join(SANDBOX, 'from-dotenv')}"\n`)
    expect(instanceClaudeHome(root)).toBe(join(SANDBOX, 'from-dotenv'))
    process.env.NESTOR_CLAUDE_HOME = join(SANDBOX, 'from-env')
    expect(instanceClaudeHome(root)).toBe(join(SANDBOX, 'from-env'))
  })
})
