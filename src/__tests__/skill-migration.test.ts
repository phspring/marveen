// Moving today's skills into the library: copy, never overwrite, never follow a link out of the tree, keep every
// existing assignment, and leave the shared directory exactly as it was.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySkillMigration, planSkillMigration } from '../skill-migration.js'
import { normalizeSkillAssignments } from '../skill-assignments.js'
import { listLibrarySkills } from '../skill-library.js'

let base: string, shared: string, lib: string, asg: string

function mkShared(name: string, files: Record<string, string> = { 'SKILL.md': `---\nname: ${name}\n---\n` }) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(shared, name, rel, '..'), { recursive: true })
    writeFileSync(join(shared, name, rel), text)
  }
}
const readAsg = () => JSON.parse(readFileSync(asg, 'utf-8')) as { assignments: Array<Record<string, unknown>> }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skillmig-'))
  shared = join(base, 'shared'); lib = join(base, 'library'); asg = join(base, 'store', 'skill-assignments.json')
  mkdirSync(shared)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('planSkillMigration', () => {
  it('lists the real skills to copy and says why the rest is skipped', () => {
    mkShared('alpha'); mkShared('beta')
    mkdirSync(join(shared, 'no-skill-md')); writeFileSync(join(shared, 'no-skill-md', 'x.txt'), 'x')
    mkShared('Bad_Name')
    writeFileSync(join(shared, 'file.txt'), 'x')
    mkdirSync(join(shared, '.hidden')); writeFileSync(join(shared, '.hidden', 'SKILL.md'), 'x')
    const p = planSkillMigration(shared, lib, asg)
    expect(p.copy).toEqual(['alpha', 'beta'])
    expect(p.skipped.map((s) => s.entry).sort()).toEqual(['Bad_Name', 'file.txt', 'no-skill-md'])
    expect(p.assignmentsError).toBeNull()
  })

  it('a skill whose top entry is a symlink to a directory is a candidate', () => {
    mkdirSync(join(base, 'elsewhere', 'linked'), { recursive: true })
    writeFileSync(join(base, 'elsewhere', 'linked', 'SKILL.md'), 'x')
    symlinkSync(join(base, 'elsewhere', 'linked'), join(shared, 'linked'))
    expect(planSkillMigration(shared, lib, asg).copy).toEqual(['linked'])
  })

  it('does not plan to overwrite a skill that is already in the library, and names the unassigned ones', () => {
    mkShared('alpha'); mkShared('beta')
    mkdirSync(join(lib, 'alpha'), { recursive: true }); writeFileSync(join(lib, 'alpha', 'SKILL.md'), 'library version')
    mkdirSync(join(lib, 'beta'), { recursive: true }); writeFileSync(join(lib, 'beta', 'SKILL.md'), 'library version')
    mkdirSync(join(base, 'store')); writeFileSync(asg, JSON.stringify({ assignments: [{ skill: 'beta', scope: 'global' }] }))
    const p = planSkillMigration(shared, lib, asg)
    expect(p.copy).toEqual([])
    expect(p.unassigned).toEqual(['alpha'])
  })

  it('an unreadable assignments file is reported, so nothing gets written', () => {
    mkShared('alpha')
    mkdirSync(join(base, 'store')); writeFileSync(asg, '{ not json')
    const p = planSkillMigration(shared, lib, asg)
    expect(p.assignmentsError).toMatch(/not valid JSON/)
    const r = applySkillMigration(p, shared, lib, asg)
    expect(r.copied).toEqual([])
    expect(existsSync(lib)).toBe(false)
    expect(readFileSync(asg, 'utf-8')).toBe('{ not json')
  })
})

describe('applySkillMigration', () => {
  it('copies the skills, assigns each globally, and leaves the shared directory as it was', () => {
    mkShared('alpha', { 'SKILL.md': 'alpha\n', 'refs/doc.md': 'doc\n' }); mkShared('beta')
    const before = readdirSync(shared).sort()
    const r = applySkillMigration(planSkillMigration(shared, lib, asg), shared, lib, asg)
    expect(r.copied).toEqual(['alpha', 'beta'])
    expect(r.assigned).toEqual(['alpha', 'beta'])
    expect(readFileSync(join(lib, 'alpha', 'refs', 'doc.md'), 'utf-8')).toBe('doc\n')
    expect(listLibrarySkills(lib)).toEqual(['alpha', 'beta'])
    expect(readdirSync(shared).sort()).toEqual(before)
    expect(existsSync(join(shared, 'alpha', 'refs', 'doc.md'))).toBe(true)
    // the result is a file the resolver accepts, and a copy is a real directory, not a link
    const set = normalizeSkillAssignments(readAsg())
    expect(set.problems).toEqual([])
    expect(set.assignments.map((a) => `${a.skill}:${a.scope}`)).toEqual(['alpha:global', 'beta:global'])
    expect(lstatSync(join(lib, 'alpha')).isSymbolicLink()).toBe(false)
  })

  it('keeps every assignment that was there, and does not add a second one for a skill that has one', () => {
    mkShared('alpha'); mkShared('beta')
    mkdirSync(join(base, 'store'))
    writeFileSync(asg, JSON.stringify({ note: 'keep', assignments: [{ skill: 'alpha', scope: 'project', project: 'p' }] }))
    applySkillMigration(planSkillMigration(shared, lib, asg), shared, lib, asg)
    const out = readAsg() as { note?: string; assignments: Array<Record<string, unknown>> }
    expect(out.note).toBe('keep')
    expect(out.assignments).toEqual([
      { skill: 'alpha', scope: 'project', project: 'p' },
      { skill: 'beta', scope: 'global' },
    ])
  })

  it('never follows a symlink inside a skill out of the tree, and says it skipped it', () => {
    writeFileSync(join(base, 'secret.txt'), 'private\n')
    mkShared('alpha', { 'SKILL.md': 'a\n' })
    symlinkSync(join(base, 'secret.txt'), join(shared, 'alpha', 'leak.txt'))
    symlinkSync(base, join(shared, 'alpha', 'dir-link'))
    const r = applySkillMigration(planSkillMigration(shared, lib, asg), shared, lib, asg)
    expect(r.skippedInside.sort()).toEqual(['alpha/dir-link', 'alpha/leak.txt'])
    expect(readdirSync(join(lib, 'alpha'))).toEqual(['SKILL.md'])
  })

  it('never overwrites a library skill that appeared after the plan', () => {
    mkShared('alpha')
    const plan = planSkillMigration(shared, lib, asg)
    mkdirSync(join(lib, 'alpha'), { recursive: true }); writeFileSync(join(lib, 'alpha', 'SKILL.md'), 'newer\n')
    const r = applySkillMigration(plan, shared, lib, asg)
    expect(r.failed.map((f) => f.skill)).toEqual(['alpha'])
    expect(readFileSync(join(lib, 'alpha', 'SKILL.md'), 'utf-8')).toBe('newer\n')
    expect(existsSync(asg)).toBe(false)
  })

  it('is idempotent: a second run copies and assigns nothing', () => {
    mkShared('alpha')
    applySkillMigration(planSkillMigration(shared, lib, asg), shared, lib, asg)
    const before = readFileSync(asg, 'utf-8')
    const second = planSkillMigration(shared, lib, asg)
    expect(second.copy).toEqual([])
    expect(applySkillMigration(second, shared, lib, asg).copied).toEqual([])
    expect(readFileSync(asg, 'utf-8')).toBe(before)
  })

  it('a missing shared directory is an empty plan, not an error', () => {
    rmSync(shared, { recursive: true })
    expect(planSkillMigration(shared, lib, asg)).toMatchObject({ copy: [], skipped: [] })
  })
})
