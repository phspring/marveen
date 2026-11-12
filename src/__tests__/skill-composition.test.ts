// The launcher's side of the skill library: who is asking (an instance is its template, with the ticket's project and
// the leaders above), and what the isolated config's `skills` entry becomes in each mode. Real directories in a temp
// dir; nothing of the install is touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySkills, leaderChain, skillContextFor, type SkillCompositionIO } from '../web/skill-composition.js'
import { normalizeSkillAssignments } from '../skill-assignments.js'
import { releaseComposedDir, COMPOSED_MARKER } from '../skill-library.js'
import type { InstanceOf } from '../web/agent-instance.js'

let base: string, lib: string, cfg: string, shared: string

function mkSkill(name: string) {
  mkdirSync(join(lib, name), { recursive: true })
  writeFileSync(join(lib, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
}

function io(over: Partial<SkillCompositionIO> & { rows?: object[]; instances?: Record<string, InstanceOf>; chain?: Record<string, string> } = {}): SkillCompositionIO {
  return {
    libraryDir: lib,
    assignments: () => normalizeSkillAssignments({ assignments: over.rows ?? [] }),
    instanceOf: (n) => over.instances?.[n] ?? null,
    reportsTo: (n) => over.chain?.[n] ?? null,
    ...over,
  }
}

const entries = (d: string) => readdirSync(d).filter((e) => e !== COMPOSED_MARKER).sort()

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skillcomp-'))
  lib = join(base, 'library'); cfg = join(base, 'cfg'); shared = join(base, 'shared-skills')
  mkdirSync(lib); mkdirSync(cfg); mkdirSync(shared)
  writeFileSync(join(shared, 'keep-me.txt'), 'shared content\n')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('leaderChain / skillContextFor', () => {
  it('is the agent then the leaders above it, nearest first', () => {
    expect(leaderChain('dev', (n) => ({ dev: 'arch', arch: 'cto' } as Record<string, string>)[n] ?? null)).toEqual(['dev', 'arch', 'cto'])
  })
  it('stops at a loop and at a depth limit', () => {
    expect(leaderChain('a', (n) => (n === 'a' ? 'b' : 'a'))).toEqual(['a', 'b'])
    expect(leaderChain('x', (n) => n + 'x', 4)).toHaveLength(4)
  })
  it('an ordinary agent: itself, no project', () => {
    expect(skillContextFor('arch', io({ chain: { arch: 'cto' } }))).toEqual({ agent: 'arch', project: null, teams: ['arch', 'cto'] })
  })
  it('an instance is its template: the ticket project, and the template leaders', () => {
    const inst: InstanceOf = { template: 'dev', ticket: 'TVR-1', project: 'tover', workspace: null }
    const ctx = skillContextFor('dev-tvr-1', io({ instances: { 'dev-tvr-1': inst }, chain: { dev: 'arch', arch: 'cto', 'dev-tvr-1': 'wrong' } }))
    expect(ctx).toEqual({ agent: 'dev', project: 'tover', teams: ['dev', 'arch', 'cto'] })
  })
})

describe('applySkills, composed', () => {
  it('builds the directory from the assignments: global, team (via the leader chain), project (via the instance)', () => {
    for (const s of ['g-skill', 't-skill', 'p-skill', 'unassigned']) mkSkill(s)
    const rows = [
      { skill: 'g-skill', scope: 'global' },
      { skill: 't-skill', scope: 'team', team: 'arch' },
      { skill: 'p-skill', scope: 'project', project: 'Tover' },
    ]
    const inst: InstanceOf = { template: 'dev', ticket: 'TVR-1', project: 'tover', workspace: null }
    const r = applySkills(cfg, 'dev-tvr-1', 'composed', io({ rows, instances: { 'dev-tvr-1': inst }, chain: { dev: 'arch' } }))
    expect(r.outcome).toMatchObject({ kind: 'composed', skills: ['g-skill', 'p-skill', 't-skill'], missing: [] })
    expect(r.mayLinkShared).toBe(false)
    expect(entries(join(cfg, 'skills'))).toEqual(['g-skill', 'p-skill', 't-skill'])
    expect(readlinkSync(join(cfg, 'skills', 'g-skill'))).toBe(join(lib, 'g-skill'))
  })

  it('the same agent outside that project does not get the project skill', () => {
    mkSkill('p-skill')
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'p-skill', scope: 'project', project: 'tover' }] }))
    expect(entries(join(cfg, 'skills'))).toEqual([])
  })

  it('replaces the link to the shared directory, never what it points at', () => {
    mkSkill('g-skill')
    symlinkSync(shared, join(cfg, 'skills'))
    const r = applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'g-skill', scope: 'global' }] }))
    expect(r.outcome.kind).toBe('composed')
    expect(lstatSync(join(cfg, 'skills')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(shared, 'keep-me.txt'))).toBe(true)
  })

  it('reports an assigned skill that is not in the library, and gives the rest', () => {
    mkSkill('here')
    const r = applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'here', scope: 'global' }, { skill: 'gone', scope: 'global' }] }))
    expect(r.outcome).toMatchObject({ kind: 'composed', skills: ['here'], missing: ['gone'] })
  })

  it('an exclude at the agent scope takes a global skill away', () => {
    mkSkill('s')
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 's', scope: 'global' }, { skill: 's', scope: 'agent', agent: 'dev', mode: 'exclude' }] }))
    expect(entries(join(cfg, 'skills'))).toEqual([])
  })

  it('without a library it falls back and leaves the shared link as it was', () => {
    rmSync(lib, { recursive: true })
    symlinkSync(shared, join(cfg, 'skills'))
    const r = applySkills(cfg, 'dev', 'composed', io())
    expect(r.outcome.kind).toBe('fallback')
    expect(r.mayLinkShared).toBe(true) // a link: the shared one may stay or come back
    expect(readlinkSync(join(cfg, 'skills'))).toBe(shared)
  })

  it('a real directory with foreign files is refused and is never offered for replacement', () => {
    mkSkill('g-skill')
    mkdirSync(join(cfg, 'skills'))
    writeFileSync(join(cfg, 'skills', 'mine.txt'), 'hand made\n')
    const r = applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'g-skill', scope: 'global' }] }))
    expect(r.outcome.kind).toBe('fallback')
    expect(r.mayLinkShared).toBe(false)
    expect(existsSync(join(cfg, 'skills', 'mine.txt'))).toBe(true)
  })

  it('is idempotent and follows a changed assignment', () => {
    mkSkill('a'); mkSkill('b')
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'a', scope: 'global' }] }))
    const again = applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'a', scope: 'global' }] }))
    expect(again.outcome).toMatchObject({ kind: 'composed', linked: 0, removed: 0 })
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'b', scope: 'global' }] }))
    expect(entries(join(cfg, 'skills'))).toEqual(['b'])
  })
})

describe('applySkills, shared', () => {
  it('leaves an ordinary link or directory alone and says the shared link may stay', () => {
    symlinkSync(shared, join(cfg, 'skills'))
    expect(applySkills(cfg, 'dev', 'shared', io())).toEqual({ outcome: { kind: 'shared' }, mayLinkShared: true })
    expect(readlinkSync(join(cfg, 'skills'))).toBe(shared)
  })

  it('an agent that goes back to shared gets its composed directory taken down (the shared link may return)', () => {
    mkSkill('g-skill')
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'g-skill', scope: 'global' }] }))
    const r = applySkills(cfg, 'dev', 'shared', io())
    expect(r).toEqual({ outcome: { kind: 'shared' }, mayLinkShared: true })
    expect(existsSync(join(cfg, 'skills'))).toBe(false)
    expect(existsSync(join(lib, 'g-skill', 'SKILL.md'))).toBe(true) // the library is untouched
  })

  it('a composed directory that also holds a real file is kept, not replaced', () => {
    mkSkill('g-skill')
    applySkills(cfg, 'dev', 'composed', io({ rows: [{ skill: 'g-skill', scope: 'global' }] }))
    writeFileSync(join(cfg, 'skills', 'mine.txt'), 'hand made\n')
    const r = applySkills(cfg, 'dev', 'shared', io())
    expect(r.outcome.kind).toBe('kept')
    expect(r.mayLinkShared).toBe(false)
    expect(existsSync(join(cfg, 'skills', 'mine.txt'))).toBe(true)
  })

  it('a plain real directory without our marker is not ours: untouched', () => {
    mkdirSync(join(cfg, 'skills'))
    writeFileSync(join(cfg, 'skills', 'x.txt'), 'x\n')
    expect(applySkills(cfg, 'dev', 'shared', io())).toEqual({ outcome: { kind: 'shared' }, mayLinkShared: true })
    expect(existsSync(join(cfg, 'skills', 'x.txt'))).toBe(true)
  })
})

describe('releaseComposedDir', () => {
  it('reports absent / foreign for what it did not make', () => {
    expect(releaseComposedDir(lib, join(cfg, 'nope')).state).toBe('absent')
    symlinkSync(shared, join(cfg, 'skills'))
    expect(releaseComposedDir(lib, join(cfg, 'skills')).state).toBe('foreign')
    expect(existsSync(join(shared, 'keep-me.txt'))).toBe(true)
  })
  it('a marker that is a symlink does not make the directory ours', () => {
    mkdirSync(join(cfg, 'skills'))
    writeFileSync(join(base, 'outside.json'), '{}')
    symlinkSync(join(base, 'outside.json'), join(cfg, 'skills', COMPOSED_MARKER))
    expect(releaseComposedDir(lib, join(cfg, 'skills')).state).toBe('foreign')
    expect(existsSync(join(base, 'outside.json'))).toBe(true)
  })
})
