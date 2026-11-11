// The assignments are read on every agent start: the same text must cost one parse and one warning, an edit must apply
// at once, and a broken file must never hand out skills.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), error: vi.fn() } }))

import { readSkillAssignments } from '../web/skill-assignments-store.js'

let dir: string
let file: string
beforeEach(() => { warn.mockClear(); dir = mkdtempSync(join(tmpdir(), 'skill-store-')); file = join(dir, 'skill-assignments.json') })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } })

const doc = (assignments: unknown[]) => JSON.stringify({ assignments })

describe('readSkillAssignments', () => {
  it('a missing file is the normal empty state, with no warning', () => {
    expect(readSkillAssignments(file)).toEqual({ assignments: [], problems: [] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads and normalises a valid file', () => {
    writeFileSync(file, doc([{ skill: 'recall', scope: 'global' }, { skill: 'tover-sim', scope: 'project', project: 'tover.tafel' }]))
    const r = readSkillAssignments(file)
    expect(r.assignments.map((a) => a.skill)).toEqual(['recall', 'tover-sim'])
    expect(r.problems).toEqual([])
  })

  it('a file that is not JSON hands out nothing, and the problem names the file that was read, once', () => {
    writeFileSync(file, '{ nope')
    for (let i = 0; i < 5; i++) expect(readSkillAssignments(file).assignments).toEqual([])
    expect(readSkillAssignments(file).problems).toEqual([`${file} is not valid JSON`])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a problem inside an otherwise valid file is logged once however often it is read, and the good entries stay', () => {
    writeFileSync(file, doc([{ skill: 'ok', scope: 'global' }, { skill: '../bad', scope: 'global' }]))
    for (let i = 0; i < 20; i++) expect(readSkillAssignments(file).assignments.map((a) => a.skill)).toEqual(['ok'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns the very same set for the same text (no re-parse)', () => {
    writeFileSync(file, doc([{ skill: 'a', scope: 'global' }]))
    expect(readSkillAssignments(file)).toBe(readSkillAssignments(file))
  })

  it('an edit applies on the next read', () => {
    writeFileSync(file, doc([{ skill: 'a', scope: 'global' }]))
    expect(readSkillAssignments(file).assignments).toHaveLength(1)
    writeFileSync(file, doc([{ skill: 'a', scope: 'global' }, { skill: 'b', scope: 'global' }]))
    expect(readSkillAssignments(file).assignments).toHaveLength(2)
  })

  it('a file that disappears is empty again, and coming back is read again', () => {
    writeFileSync(file, doc([{ skill: 'a', scope: 'global' }]))
    expect(readSkillAssignments(file).assignments).toHaveLength(1)
    unlinkSync(file)
    expect(readSkillAssignments(file).assignments).toEqual([])
    writeFileSync(file, doc([{ skill: 'a', scope: 'global' }]))
    expect(readSkillAssignments(file).assignments).toHaveLength(1)
  })
})
