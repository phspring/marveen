import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeAgentName } from '../web/sanitize.js'
import {
  instanceName, createAgentInstance, removeAgentInstance, listAgentInstances, readInstanceOf,
} from '../web/agent-instance.js'

let base: string

function makeTemplate(name = 'cpp-developer'): string {
  const dir = join(base, name)
  mkdirSync(join(dir, '.claude', 'skills', 'own-skill'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
    model: 'claude-sonnet-5-5', securityProfile: 'default', displayName: 'C++ Developer',
    remoteHost: 'box', remoteWorkdir: '/x', claudeConfigDir: '/c', oauthTokenFile: '/t',
    team: { role: 'member', reportsTo: 'cpp-architect', delegatesTo: ['someone'], autoDelegation: true, trustFrom: ['peer'] },
  }))
  writeFileSync(join(dir, 'CLAUDE.md'), '# cpp-developer\n\nTemplate text.\n')
  writeFileSync(join(dir, 'SOUL.md'), 'soul\n')
  writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}')
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"hooks":{}}')
  writeFileSync(join(dir, '.claude', 'agents', 'quarantine-reader.md'), 'reader\n')
  writeFileSync(join(dir, '.claude', 'skills', 'own-skill', 'SKILL.md'), 'skill\n')
  writeFileSync(join(dir, 'memory', 'note.md'), 'template memory\n')
  return dir
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agent-inst-')) })
afterEach(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ } })

describe('instanceName', () => {
  it('is <template>-<ticket>, lower case, and survives sanitizeAgentName unchanged', () => {
    expect(instanceName('cpp-developer', 'TVR-2658')).toBe('cpp-developer-tvr-2658')
    for (const [t, k] of [['cpp-developer', 'TVR-2658'], ['php-laravel-architect', 'ABC.12_x'], ['a', 'b']]) {
      const n = instanceName(t, k)!
      expect(sanitizeAgentName(n)).toBe(n)
      expect(n.length).toBeLessThanOrEqual(50)
    }
  })

  it('a long template and ticket get a hash and stay within 50 characters, sanitizer-stable and deterministic', () => {
    const a = instanceName('capacitor-mobile-developer', 'LONGPROJECT-123456789012345678901234567890')!
    expect(a.length).toBeLessThanOrEqual(50)
    expect(sanitizeAgentName(a)).toBe(a)
    expect(instanceName('capacitor-mobile-developer', 'LONGPROJECT-123456789012345678901234567890')).toBe(a)
  })

  it('two different long tickets that would be cut to the same text still get different names', () => {
    const t = 'capacitor-mobile-developer'
    // the two differ only in the part the readable tail drops, so only the hash can tell them apart
    const a = instanceName(t, 'PROJECTA-1234567890123456789012345678901234567890')!
    const b = instanceName(t, 'PROJECTB-1234567890123456789012345678901234567890')!
    expect(a).not.toBe(b)
    expect(a.slice(0, -7)).toBe(b.slice(0, -7))
  })

  it('the same ticket on two templates gives two names', () => {
    expect(instanceName('cpp-developer', 'T-1')).not.toBe(instanceName('cpp-tester', 'T-1'))
  })

  it('refuses unusable tickets and templates', () => {
    for (const k of ['', '../x', 'a b', '-x', null, undefined]) expect(instanceName('cpp-developer', k)).toBeNull()
    expect(instanceName('', 'T-1')).toBeNull()
    expect(instanceName('!!!', 'T-1')).toBeNull()
  })
})

describe('createAgentInstance', () => {
  it('builds a real agent directory from the template and marks it as an instance', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-2658', { project: 'tover.tafel', workspace: '/ws/tover/TVR-2658' })
    expect(r).toMatchObject({ ok: true, name: 'cpp-developer-tvr-2658', created: true })
    if (!r.ok) return

    expect(readInstanceOf(r.dir)).toEqual({ template: 'cpp-developer', ticket: 'TVR-2658', project: 'tover.tafel', workspace: '/ws/tover/TVR-2658' })
    const cfg = JSON.parse(readFileSync(join(r.dir, 'agent-config.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5-5')
    expect(cfg.displayName).toBe('C++ Developer · TVR-2658')
    for (const k of ['remoteHost', 'remoteWorkdir', 'claudeConfigDir', 'oauthTokenFile']) expect(cfg).not.toHaveProperty(k)
    expect(cfg.team).toEqual({ role: 'member', reportsTo: 'cpp-architect', delegatesTo: [], autoDelegation: false, trustFrom: ['peer'] })

    // the template is untouched
    expect(readFileSync(join(tpl, 'CLAUDE.md'), 'utf-8')).toBe('# cpp-developer\n\nTemplate text.\n')
    expect(readInstanceOf(tpl)).toBeNull()
  })

  it('copies what the launcher rewrites, and writes the ticket and the literal workspace path into CLAUDE.md', () => {
    makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-2658', { workspace: '/ws/tover/TVR-2658' })
    if (!r.ok) throw new Error(r.error)
    for (const f of ['SOUL.md', '.mcp.json', '.claude/settings.json', '.claude/agents/quarantine-reader.md']) {
      expect(lstatSync(join(r.dir, f)).isSymbolicLink()).toBe(false)
      expect(existsSync(join(r.dir, f))).toBe(true)
    }
    const md = readFileSync(join(r.dir, 'CLAUDE.md'), 'utf-8')
    expect(md).toContain('Template text.')
    expect(md).toContain('git -C /ws/tover/TVR-2658')
    expect(md).toContain('TVR-2658')
    expect(md.match(/INSTANCE-BEGIN/g)).toHaveLength(1)
  })

  it('a write into the instance never reaches the template (CLAUDE.md, settings, mcp are copies)', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'CLAUDE.md'), 'rewritten by the launcher\n')
    writeFileSync(join(r.dir, '.claude', 'settings.json'), '{"changed":true}')
    writeFileSync(join(r.dir, '.mcp.json'), '{"changed":true}')
    expect(readFileSync(join(tpl, 'CLAUDE.md'), 'utf-8')).toContain('Template text.')
    expect(readFileSync(join(tpl, '.claude', 'settings.json'), 'utf-8')).toBe('{"hooks":{}}')
    expect(readFileSync(join(tpl, '.mcp.json'), 'utf-8')).toBe('{"mcpServers":{}}')
  })

  it('links the template skills instead of copying them, and starts with an empty memory of its own', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    const link = join(r.dir, '.claude', 'skills', 'own-skill')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(tpl, '.claude', 'skills', 'own-skill'))
    expect(readFileSync(join(link, 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expect(existsSync(join(r.dir, 'memory', 'note.md'))).toBe(false)
    expect(readFileSync(join(r.dir, 'memory', 'MEMORY.md'), 'utf-8')).toBe('')
  })

  it('is idempotent for the same ticket and refuses a name taken by something else', () => {
    makeTemplate()
    const first = createAgentInstance(base, 'cpp-developer', 'T-1')
    expect(createAgentInstance(base, 'cpp-developer', 'T-1')).toMatchObject({ ok: true, created: false, name: first.ok ? first.name : '' })

    // an ordinary agent that happens to carry the instance name
    const name = instanceName('cpp-developer', 'T-2')!
    mkdirSync(join(base, name), { recursive: true })
    writeFileSync(join(base, name, 'agent-config.json'), '{}')
    expect(createAgentInstance(base, 'cpp-developer', 'T-2').ok).toBe(false)
  })

  it('refuses a missing or incomplete template, an instance as a template, and a reserved id', () => {
    expect(createAgentInstance(base, 'nope', 'T-1').ok).toBe(false)
    makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    expect(createAgentInstance(base, r.name, 'T-9')).toMatchObject({ ok: false, error: expect.stringContaining('instance cannot be a template') })
    expect(createAgentInstance(base, 'cpp-developer', 'T-3', { reservedIds: ['cpp-developer'] }).ok).toBe(false)
  })

  it('refuses a path-traversal template name', () => {
    expect(() => createAgentInstance(base, '../outside', 'T-1')).toThrow()
  })

  it('without a workspace the section says there is none', () => {
    makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    expect(readFileSync(join(r.dir, 'CLAUDE.md'), 'utf-8')).toContain('nincs külön munkakönyvtár')
  })
})

describe('listAgentInstances / removeAgentInstance', () => {
  it('lists only instances', () => {
    makeTemplate()
    createAgentInstance(base, 'cpp-developer', 'T-1')
    createAgentInstance(base, 'cpp-developer', 'T-2')
    expect(listAgentInstances(base).map((i) => i.of.ticket).sort()).toEqual(['T-1', 'T-2'])
  })

  it('removes an instance without touching the template or following its skill links', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    expect(removeAgentInstance(base, r.name, { isRunning: () => false })).toEqual({ ok: true, removed: true })
    expect(existsSync(r.dir)).toBe(false)
    expect(readFileSync(join(tpl, '.claude', 'skills', 'own-skill', 'SKILL.md'), 'utf-8')).toBe('skill\n')
  })

  it('refuses a running instance and a real (non-instance) agent', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'T-1')
    if (!r.ok) throw new Error(r.error)
    expect(removeAgentInstance(base, r.name, { isRunning: () => true }).ok).toBe(false)
    expect(existsSync(r.dir)).toBe(true)
    expect(removeAgentInstance(base, 'cpp-developer', { isRunning: () => false }).ok).toBe(false)
    expect(existsSync(tpl)).toBe(true)
  })

  it('a missing instance is a no-op, and a traversal name is rejected', () => {
    expect(removeAgentInstance(base, 'ghost', { isRunning: () => false })).toEqual({ ok: true, removed: false })
    expect(removeAgentInstance(base, '../x', { isRunning: () => false }).ok).toBe(false)
  })
})
