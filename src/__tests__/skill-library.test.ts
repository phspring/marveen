import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLibrarySkills, composeSkillsDir, COMPOSED_MARKER } from '../skill-library.js'

let root: string
let lib: string
let tgt: string

function skill(name: string, body = `# ${name}\n`): void {
  mkdirSync(join(lib, name), { recursive: true })
  writeFileSync(join(lib, name, 'SKILL.md'), body)
}
const entries = (d: string): string[] => readdirSync(d).filter((n) => n !== COMPOSED_MARKER).sort()
const isLink = (p: string): boolean => lstatSync(p).isSymbolicLink()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-lib-'))
  lib = join(root, 'library')
  tgt = join(root, 'agent', 'skills')
  mkdirSync(lib, { recursive: true })
})
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* temp */ } })

describe('listLibrarySkills', () => {
  it('lists real skill directories with a SKILL.md and a valid name, sorted', () => {
    skill('tover-sim'); skill('recall'); skill('tvr-feature')
    expect(listLibrarySkills(lib)).toEqual(['recall', 'tover-sim', 'tvr-feature'])
  })

  it('leaves out everything that is not a skill: no SKILL.md, a loose file, a bad name, a hidden entry', () => {
    skill('ok')
    mkdirSync(join(lib, 'no-skill-md'))
    writeFileSync(join(lib, 'loose-file'), 'x')
    mkdirSync(join(lib, 'Bad Name')); writeFileSync(join(lib, 'Bad Name', 'SKILL.md'), 'x')
    mkdirSync(join(lib, '.hidden')); writeFileSync(join(lib, '.hidden', 'SKILL.md'), 'x')
    expect(listLibrarySkills(lib)).toEqual(['ok'])
  })

  it('a symlink in the library is not a skill: it could point anywhere', () => {
    skill('real')
    mkdirSync(join(root, 'elsewhere')); writeFileSync(join(root, 'elsewhere', 'SKILL.md'), 'x')
    symlinkSync(join(root, 'elsewhere'), join(lib, 'sneaky'))
    expect(listLibrarySkills(lib)).toEqual(['real'])
  })

  it('a missing library is an empty one', () => {
    expect(listLibrarySkills(join(root, 'nope'))).toEqual([])
  })
})

describe('composeSkillsDir', () => {
  it('builds a real directory of symlinks into the library, one per wanted skill', () => {
    skill('a'); skill('b'); skill('c')
    const r = composeSkillsDir(lib, tgt, ['a', 'c'])
    expect(r).toMatchObject({ ok: true, report: { linked: ['a', 'c'], unchanged: [], removed: [], skipped: [] } })
    expect(lstatSync(tgt).isDirectory() && !isLink(tgt)).toBe(true)
    expect(entries(tgt)).toEqual(['a', 'c'])
    expect(isLink(join(tgt, 'a'))).toBe(true)
    expect(readlinkSync(join(tgt, 'a'))).toBe(join(lib, 'a'))
    expect(existsSync(join(tgt, 'b'))).toBe(false)
  })

  it('a skill edited in the library is the same file for everyone who has it: nothing to copy, nothing to update', () => {
    skill('shared', 'version one\n')
    const other = join(root, 'other-agent', 'skills')
    composeSkillsDir(lib, tgt, ['shared']); composeSkillsDir(lib, other, ['shared'])
    writeFileSync(join(lib, 'shared', 'SKILL.md'), 'version two\n')
    expect(readFileSync(join(tgt, 'shared', 'SKILL.md'), 'utf-8')).toBe('version two\n')
    expect(readFileSync(join(other, 'shared', 'SKILL.md'), 'utf-8')).toBe('version two\n')
  })

  it('is idempotent: a second run changes nothing', () => {
    skill('a'); skill('b')
    composeSkillsDir(lib, tgt, ['a', 'b'])
    const again = composeSkillsDir(lib, tgt, ['a', 'b'])
    expect(again).toMatchObject({ ok: true, report: { linked: [], unchanged: ['a', 'b'], removed: [] } })
  })

  it('follows a changed set: a new skill is linked, one no longer wanted is removed, a repointed link is repaired', () => {
    skill('a'); skill('b'); skill('c')
    composeSkillsDir(lib, tgt, ['a', 'b'])
    // a link someone pointed elsewhere (the retargeting the launcher also guards against)
    rmSync(join(tgt, 'a')); symlinkSync(join(root, 'evil'), join(tgt, 'a'))
    const r = composeSkillsDir(lib, tgt, ['a', 'c'])
    expect(r).toMatchObject({ ok: true, report: { linked: ['a', 'c'], removed: ['b'] } })
    expect(entries(tgt)).toEqual(['a', 'c'])
    expect(readlinkSync(join(tgt, 'a'))).toBe(join(lib, 'a'))
  })

  it('an empty wanted set removes every link it had made and leaves an empty composed directory', () => {
    skill('a'); skill('b')
    composeSkillsDir(lib, tgt, ['a', 'b'])
    expect(composeSkillsDir(lib, tgt, [])).toMatchObject({ ok: true, report: { removed: ['a', 'b'] } })
    expect(entries(tgt)).toEqual([])
    expect(existsSync(join(lib, 'a', 'SKILL.md'))).toBe(true)
  })

  it('skips, and says why, a skill that is not in the library, has a bad name, or has a real entry in its way', () => {
    skill('here')
    mkdirSync(tgt, { recursive: true })
    writeFileSync(join(tgt, COMPOSED_MARKER), '{}')
    mkdirSync(join(tgt, 'taken')); writeFileSync(join(tgt, 'taken', 'mine.txt'), 'precious')
    skill('taken')
    const r = composeSkillsDir(lib, tgt, ['here', 'missing', '../evil', 'taken'])
    expect(r.ok && r.report.linked).toEqual(['here'])
    const skipped = r.ok ? Object.fromEntries(r.report.skipped.map((s) => [s.skill, s.reason])) : {}
    expect(skipped['missing']).toContain('not in the library')
    expect(skipped['../evil']).toContain('not a valid skill name')
    expect(skipped['taken']).toContain('real file or directory')
    // the real entry was not touched
    expect(readFileSync(join(tgt, 'taken', 'mine.txt'), 'utf-8')).toBe('precious')
  })

  it('never removes a real file or directory, and never a symlink that does not point into the library', () => {
    skill('a')
    composeSkillsDir(lib, tgt, ['a'])
    mkdirSync(join(tgt, 'real-dir')); writeFileSync(join(tgt, 'real-dir', 'x.txt'), 'x')
    writeFileSync(join(tgt, 'real-file'), 'y')
    mkdirSync(join(root, 'outside')); symlinkSync(join(root, 'outside'), join(tgt, 'foreign-link'))
    const r = composeSkillsDir(lib, tgt, ['a'])
    expect(r).toMatchObject({ ok: true, report: { removed: [] } })
    expect(entries(tgt)).toEqual(['a', 'foreign-link', 'real-dir', 'real-file'])
    expect(existsSync(join(root, 'outside'))).toBe(true)
  })

  it('refuses a target that holds someone else\'s files, and changes nothing', () => {
    skill('a')
    mkdirSync(tgt, { recursive: true })
    writeFileSync(join(tgt, 'their-skill.md'), 'theirs')
    const r = composeSkillsDir(lib, tgt, ['a'])
    expect(r.ok).toBe(false)
    expect(readdirSync(tgt)).toEqual(['their-skill.md'])
  })

  it('accepts an empty existing target, and a target that is a file or inside / around the library is an error', () => {
    skill('a')
    mkdirSync(tgt, { recursive: true })
    expect(composeSkillsDir(lib, tgt, ['a']).ok).toBe(true)

    const file = join(root, 'a-file'); writeFileSync(file, 'x')
    expect(composeSkillsDir(lib, file, ['a']).ok).toBe(false)
    expect(composeSkillsDir(lib, join(lib, 'inside'), ['a']).ok).toBe(false)
    expect(composeSkillsDir(lib, lib, ['a']).ok).toBe(false)
    expect(composeSkillsDir(lib, root, ['a']).ok).toBe(false)
  })

  it('a missing library is an error', () => {
    expect(composeSkillsDir(join(root, 'nope'), tgt, ['a']).ok).toBe(false)
  })
})

describe('composeSkillsDir: replacing the link the isolated config directory has today', () => {
  it('a symlink target is refused unless asked, and then the LINK is replaced, never what it points at', () => {
    skill('a')
    const shared = join(root, 'shared-skills')
    mkdirSync(shared); writeFileSync(join(shared, 'important.md'), 'must survive')
    mkdirSync(join(root, 'agent'), { recursive: true })
    symlinkSync(shared, tgt)

    expect(composeSkillsDir(lib, tgt, ['a']).ok).toBe(false)
    expect(isLink(tgt)).toBe(true)

    expect(composeSkillsDir(lib, tgt, ['a'], { replaceLink: true }).ok).toBe(true)
    expect(isLink(tgt)).toBe(false)
    expect(entries(tgt)).toEqual(['a'])
    expect(readFileSync(join(shared, 'important.md'), 'utf-8')).toBe('must survive')
  })
})

describe('the marker', () => {
  it('records what was composed, and its presence lets the next run reuse the directory', () => {
    skill('a'); skill('b')
    composeSkillsDir(lib, tgt, ['b', 'a'])
    const marker = JSON.parse(readFileSync(join(tgt, COMPOSED_MARKER), 'utf-8'))
    expect(marker.skills).toEqual(['a', 'b'])
    expect(marker.library).toBe(lib)
    expect(composeSkillsDir(lib, tgt, ['a']).ok).toBe(true)
  })
})
