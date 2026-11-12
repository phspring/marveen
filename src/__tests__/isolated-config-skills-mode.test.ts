// The launcher wiring of the skill library: provisionIsolatedConfigDir builds the agent's `skills` entry per its
// agent-config.json `skillsMode`. Default (shared): today's link to the whole shared skills directory, unchanged.
// composed: a real directory of links into the library, and the loop that links every other ~/.claude entry must
// never replace it (it removes what is in its way recursively). Going back to shared must give the link back
// without losing a real file that someone put in the composed directory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ lib: '', rows: [] as object[] }))
vi.mock('../web/skill-assignments-store.js', async () => {
  const { normalizeSkillAssignments } = await import('../skill-assignments.js')
  return {
    get SKILL_LIBRARY_DIR() { return state.lib },
    SKILL_ASSIGNMENTS_PATH: '/nonexistent',
    readSkillAssignments: () => normalizeSkillAssignments({ assignments: state.rows }),
  }
})

import { ensureIsolatedChannelConfigDir } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

const PROBE = 'skillsmode-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
const cfgSkills = join(probeDir, '.claude-config', 'skills')

let fakeHome: string
let realHome: string | undefined
let sharedSkills: string

function mkSkill(name: string) {
  mkdirSync(join(state.lib, name), { recursive: true })
  writeFileSync(join(state.lib, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
}
function setMode(mode?: string) {
  writeFileSync(join(probeDir, 'agent-config.json'), JSON.stringify(mode ? { skillsMode: mode } : {}))
}

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'skillsmode-'))
  process.env.HOME = fakeHome
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{}')
  sharedSkills = join(fakeHome, '.claude', 'skills')
  mkdirSync(join(sharedSkills, 'old-skill'), { recursive: true })
  writeFileSync(join(sharedSkills, 'old-skill', 'SKILL.md'), 'old\n')
  state.lib = join(fakeHome, 'library')
  mkdirSync(state.lib)
  state.rows = []
  if (existsSync(join(probeDir, 'HANDOFF.md'))) throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(probeDir, { recursive: true })
})
afterEach(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
})

describe('skillsMode in the isolated config', () => {
  it('default: the skills entry is the link to the whole shared directory, as before', () => {
    setMode()
    mkSkill('lib-skill'); state.rows = [{ skill: 'lib-skill', scope: 'global' }]
    expect(ensureIsolatedChannelConfigDir(PROBE, null)).not.toBeNull()
    expect(lstatSync(cfgSkills).isSymbolicLink()).toBe(true)
    expect(readlinkSync(cfgSkills)).toBe(sharedSkills)
  })

  it('composed: a real directory of links into the library, the shared directory untouched', () => {
    setMode('composed')
    mkSkill('lib-skill'); mkSkill('other'); state.rows = [{ skill: 'lib-skill', scope: 'global' }]
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(lstatSync(cfgSkills).isSymbolicLink()).toBe(false)
    expect(readdirSync(cfgSkills).filter((e) => !e.startsWith('.')).sort()).toEqual(['lib-skill'])
    expect(readlinkSync(join(cfgSkills, 'lib-skill'))).toBe(join(state.lib, 'lib-skill'))
    expect(existsSync(join(sharedSkills, 'old-skill', 'SKILL.md'))).toBe(true)
  })

  it('composed survives a second provision (the entry loop does not replace it) and follows a new assignment', () => {
    setMode('composed')
    mkSkill('a'); mkSkill('b'); state.rows = [{ skill: 'a', scope: 'global' }]
    ensureIsolatedChannelConfigDir(PROBE, null)
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(lstatSync(cfgSkills).isSymbolicLink()).toBe(false)
    state.rows = [{ skill: 'a', scope: 'global' }, { skill: 'b', scope: 'agent', agent: PROBE }]
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(readdirSync(cfgSkills).filter((e) => !e.startsWith('.')).sort()).toEqual(['a', 'b'])
  })

  it('composed with a hand-made real directory in the way: nothing deleted, no shared link forced over it', () => {
    setMode('composed')
    mkSkill('a'); state.rows = [{ skill: 'a', scope: 'global' }]
    mkdirSync(cfgSkills, { recursive: true })
    writeFileSync(join(cfgSkills, 'mine.txt'), 'hand made\n')
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(existsSync(join(cfgSkills, 'mine.txt'))).toBe(true)
    expect(lstatSync(cfgSkills).isSymbolicLink()).toBe(false)
  })

  it('composed with no library falls back: the shared link stays', () => {
    setMode('composed')
    rmSync(state.lib, { recursive: true })
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(readlinkSync(cfgSkills)).toBe(sharedSkills)
  })

  it('back to shared: the composed directory goes and the shared link returns', () => {
    setMode('composed')
    mkSkill('a'); state.rows = [{ skill: 'a', scope: 'global' }]
    ensureIsolatedChannelConfigDir(PROBE, null)
    setMode('shared')
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(readlinkSync(cfgSkills)).toBe(sharedSkills)
    expect(existsSync(join(state.lib, 'a', 'SKILL.md'))).toBe(true)
  })

  it('back to shared with a real file in the composed directory: the file is kept', () => {
    setMode('composed')
    mkSkill('a'); state.rows = [{ skill: 'a', scope: 'global' }]
    ensureIsolatedChannelConfigDir(PROBE, null)
    writeFileSync(join(cfgSkills, 'mine.txt'), 'hand made\n')
    setMode('shared')
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(existsSync(join(cfgSkills, 'mine.txt'))).toBe(true)
    expect(lstatSync(cfgSkills).isSymbolicLink()).toBe(false)
  })

  it('a misspelt mode reads as shared', () => {
    setMode('compozed')
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(readlinkSync(cfgSkills)).toBe(sharedSkills)
  })
})
