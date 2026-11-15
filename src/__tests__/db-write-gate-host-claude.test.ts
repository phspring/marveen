// docs/sajat-claude-home.md: NO agent of an install writes the host user's ~/.claude or ~/.claude.json -- the main
// agent neither. Enforced by the write gate (code), not by a skill or CLAUDE.md line. The instance's own home is free.
// The decision functions only read paths: nothing here writes to the home directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

let base: string
let root: string
let agent: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'host-claude-gate-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  mkdirSync(join(agent, '.claude-config'), { recursive: true })
  mkdirSync(join(root, '.claude-home', 'skills'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const H = homedir()
const main = () => ({ root, cwd: root, subAgent: false, projectDir: root, configDir: join(root, '.claude-home') })
const sub = () => ({ root, cwd: agent, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })
const write = (p: string, ctx: object) => gateDecision('Write', { file_path: p, content: 'x' }, ctx)
const bash = (c: string, ctx: object) => gateDecision('Bash', { command: c }, ctx)

// The places things get SAVED. The host channel state keeps its own per-file rules until phase 2.
describe('the host ~/.claude save locations are closed to every agent of the install', () => {
  const hostTargets = () => [
    join(H, '.claude', 'skills', 'react-admin', 'SKILL.md'),
    join(H, '.claude', 'CLAUDE.md'),
    join(H, '.claude', 'scheduled-tasks', 't', 'SKILL.md'),
    join(H, '.claude', 'settings.json'),
    join(H, '.claude', 'settings.local.json'),
    join(H, '.claude', 'agents', 'x.md'),
    join(H, '.claude', 'commands', 'x.md'),
    join(H, '.claude', 'tools', 'x', 'a.json'),
    join(H, '.claude', 'hooks', 'x.cjs'),
    join(H, '.claude', 'plugins', 'cache', 'm', 'p', 'server.ts'),
    join(H, '.claude.json'),
  ]
  it('the MAIN agent may not write there (native Write)', () => {
    for (const t of hostTargets()) expect(write(t, main()).deny, t).toBe(true)
  })
  it('a sub-agent may not write there either', () => {
    for (const t of hostTargets()) expect(write(t, sub()).deny, t).toBe(true)
  })
  it.each([
    'mkdir -p ~/.claude/skills/x && cp /tmp/x/SKILL.md ~/.claude/skills/x/SKILL.md',
    'cp -r /tmp/graphify ~/.claude/skills/graphify',
    'echo x > "$HOME/.claude/CLAUDE.md"',
    'rm -rf ~/.claude/skills/old',
  ])('Bash from the main agent: %s', (cmd) => {
    expect(bash(cmd, main()).deny).toBe(true)
  })
  it('through a link that leads into the host (the real path is judged)', () => {
    symlinkSync(join(H, '.claude'), join(base, 'sneaky'))
    expect(write(join(base, 'sneaky', 'skills', 'x', 'SKILL.md'), main()).deny).toBe(true)
  })
})

describe('the instance\'s own home stays free', () => {
  it('the main agent writes its own skills', () => {
    expect(write(join(root, '.claude-home', 'skills', 'x', 'SKILL.md'), main()).deny).toBe(false)
  })
  it('reading the host is not a write', () => {
    expect(bash('ls ~/.claude/skills', main()).deny).toBe(false)
  })
})
