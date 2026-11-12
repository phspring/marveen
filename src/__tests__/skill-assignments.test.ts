import { describe, it, expect } from 'vitest'
import {
  normalizeSkillAssignments, resolveSkillSet, isValidSkillName, SCOPE_LEVEL,
  type SkillContext, type SkillAssignmentSet,
} from '../skill-assignments.js'

const lib = (...names: string[]): ReadonlySet<string> => new Set(names)
const names = (r: { skills: Array<{ skill: string }> }): string[] => r.skills.map((s) => s.skill)
const set = (assignments: unknown[]): SkillAssignmentSet => normalizeSkillAssignments({ assignments })

const ctx = (over: Partial<SkillContext> = {}): SkillContext => ({ agent: 'cpp-developer', project: 'tover.tafel', teams: ['cpp-architect'], ...over })

describe('isValidSkillName', () => {
  it('accepts the shape the existing skills have, and nothing else', () => {
    for (const ok of ['recall', 'tover-sim', 'tvr-write-feature-test', 'a1']) expect(isValidSkillName(ok), ok).toBe(true)
    for (const bad of ['', 'Tover-Sim', 'a b', 'a/b', '../x', 'a..b', '-x', 'x-', 'a--b', 'x'.repeat(51), 3, null, undefined]) {
      expect(isValidSkillName(bad), String(bad)).toBe(false)
    }
  })
})

describe('normalizeSkillAssignments', () => {
  it('is empty for anything that is not a list of assignments', () => {
    for (const v of [null, undefined, 'x', 3, [], {}, { assignments: 'x' }, { assignments: {} }]) {
      expect(normalizeSkillAssignments(v)).toEqual({ assignments: [], problems: [] })
    }
  })

  it('keeps a valid entry of every scope, with the fields that scope needs', () => {
    const r = set([
      { skill: 'recall', scope: 'global' },
      { skill: 'tover-sim', scope: 'project', project: 'tover.tafel' },
      { skill: 'tvr-feature', scope: 'team', team: 'cpp-architect' },
      { skill: 'pixel-gate', scope: 'agent', agent: 'cpp-developer' },
      { skill: 'tover-design-system', scope: 'agent-project', agent: 'cpp-developer', project: 'tover.tafel', mode: 'exclude' },
    ])
    expect(r.problems).toEqual([])
    expect(r.assignments.map((a) => [a.skill, a.scope, a.mode])).toEqual([
      ['recall', 'global', 'include'], ['tover-sim', 'project', 'include'], ['tvr-feature', 'team', 'include'],
      ['pixel-gate', 'agent', 'include'], ['tover-design-system', 'agent-project', 'exclude'],
    ])
  })

  it('drops, and reports, entries that are malformed or miss what their scope needs', () => {
    const r = set([
      null, 'x', [],
      { skill: '../evil', scope: 'global' },
      { skill: 'Bad Name', scope: 'global' },
      { skill: 'ok', scope: 'universe' },
      { skill: 'ok', scope: 'global', mode: 'maybe' },
      { skill: 'ok', scope: 'project' },
      { skill: 'ok', scope: 'project', project: '  ' },
      { skill: 'ok', scope: 'team', team: 'Not An Id' },
      { skill: 'ok', scope: 'agent' },
      { skill: 'ok', scope: 'agent-project', agent: 'a' },
      { skill: 'ok', scope: 'agent-project', project: 'p' },
    ])
    expect(r.assignments).toEqual([])
    expect(r.problems).toHaveLength(13)
  })

  it('ignores fields a scope does not use, so a global entry cannot be narrowed by a stray project', () => {
    const r = set([{ skill: 'recall', scope: 'global', project: 'p', agent: 'a', team: 't' }])
    expect(r.assignments[0]).toMatchObject({ scope: 'global', project: null, agent: null, team: null })
  })

  it('the same assignment twice is one; if the two disagree, exclude is kept and it is said', () => {
    const same = set([{ skill: 'a', scope: 'global' }, { skill: 'a', scope: 'global' }])
    expect(same.assignments).toHaveLength(1)
    expect(same.problems).toEqual([])

    const conflict = set([{ skill: 'a', scope: 'agent', agent: 'x' }, { skill: 'a', scope: 'agent', agent: 'x', mode: 'exclude' }])
    expect(conflict.assignments).toHaveLength(1)
    expect(conflict.assignments[0].mode).toBe('exclude')
    expect(conflict.problems).toHaveLength(1)
    const reversed = set([{ skill: 'a', scope: 'agent', agent: 'x', mode: 'exclude' }, { skill: 'a', scope: 'agent', agent: 'x' }])
    expect(reversed.assignments[0].mode).toBe('exclude')
  })

  it('project names that differ only in case are the same assignment', () => {
    const r = set([{ skill: 'a', scope: 'project', project: 'Tover.Tafel' }, { skill: 'a', scope: 'project', project: 'tover.tafel', mode: 'exclude' }])
    expect(r.assignments).toHaveLength(1)
    expect(r.assignments[0].mode).toBe('exclude')
  })
})

describe('resolveSkillSet: scopes', () => {
  const all = set([
    { skill: 'g', scope: 'global' },
    { skill: 'p', scope: 'project', project: 'tover.tafel' },
    { skill: 't', scope: 'team', team: 'cpp-architect' },
    { skill: 'a', scope: 'agent', agent: 'cpp-developer' },
    { skill: 'ap', scope: 'agent-project', agent: 'cpp-developer', project: 'tover.tafel' },
  ])
  const library = lib('g', 'p', 't', 'a', 'ap')

  it('the context that matches everything gets everything, each with the scope that gave it', () => {
    const r = resolveSkillSet(all, ctx(), library)
    expect(r.skills).toEqual([
      { skill: 'a', via: 'agent' }, { skill: 'ap', via: 'agent-project' }, { skill: 'g', via: 'global' },
      { skill: 'p', via: 'project' }, { skill: 't', via: 'team' },
    ])
    expect(r.missing).toEqual([])
  })

  it('each scope reaches only its own: another project, another team, another agent', () => {
    expect(names(resolveSkillSet(all, ctx({ project: 'other' }), library))).toEqual(['a', 'g', 't'])
    expect(names(resolveSkillSet(all, ctx({ teams: ['someone-else'] }), library))).toEqual(['a', 'ap', 'g', 'p'])
    expect(names(resolveSkillSet(all, ctx({ agent: 'cpp-tester' }), library))).toEqual(['g', 'p', 't'])
    expect(names(resolveSkillSet(all, ctx({ agent: null, project: null, teams: [] }), library))).toEqual(['g'])
  })

  it('the project matches case-insensitively and ignores surrounding spaces; the team matches any leader in the chain', () => {
    expect(names(resolveSkillSet(all, ctx({ project: '  TOVER.Tafel ' }), library))).toContain('p')
    expect(names(resolveSkillSet(all, ctx({ teams: ['top-leader', 'cpp-architect'] }), library))).toContain('t')
  })

  it('agent-project needs BOTH: the agent in the wrong project, or another agent in the right one, does not get it', () => {
    expect(names(resolveSkillSet(all, ctx({ project: 'other' }), library))).not.toContain('ap')
    expect(names(resolveSkillSet(all, ctx({ agent: 'cpp-tester' }), library))).not.toContain('ap')
  })
})

describe('resolveSkillSet: the most specific assignment decides', () => {
  it('an agent exclude takes a skill away that everyone has', () => {
    const s = set([{ skill: 'noisy', scope: 'global' }, { skill: 'noisy', scope: 'agent', agent: 'cpp-developer', mode: 'exclude' }])
    expect(names(resolveSkillSet(s, ctx(), lib('noisy')))).toEqual([])
    expect(names(resolveSkillSet(s, ctx({ agent: 'cpp-tester' }), lib('noisy')))).toEqual(['noisy'])
  })

  it('a more specific include brings it back: excluded for the agent, included for the agent in one project', () => {
    const s = set([
      { skill: 'x', scope: 'global' },
      { skill: 'x', scope: 'agent', agent: 'cpp-developer', mode: 'exclude' },
      { skill: 'x', scope: 'agent-project', agent: 'cpp-developer', project: 'tover.tafel' },
    ])
    expect(names(resolveSkillSet(s, ctx(), lib('x')))).toEqual(['x'])
    expect(names(resolveSkillSet(s, ctx({ project: 'other' }), lib('x')))).toEqual([])
  })

  it('a project exclude beats a global include, and a team include beats a project exclude', () => {
    const s = set([
      { skill: 'x', scope: 'global' },
      { skill: 'x', scope: 'project', project: 'tover.tafel', mode: 'exclude' },
    ])
    expect(names(resolveSkillSet(s, ctx(), lib('x')))).toEqual([])
    const s2 = set([
      { skill: 'x', scope: 'project', project: 'tover.tafel', mode: 'exclude' },
      { skill: 'x', scope: 'team', team: 'cpp-architect' },
    ])
    expect(names(resolveSkillSet(s2, ctx(), lib('x')))).toEqual(['x'])
  })

  it('at the same scope an exclude beats an include (the safe side), whatever the order', () => {
    const a = set([{ skill: 'x', scope: 'team', team: 'cpp-architect' }, { skill: 'x', scope: 'team', team: 'cpp-architect', mode: 'exclude' }])
    expect(names(resolveSkillSet(a, ctx(), lib('x')))).toEqual([])
    // two DIFFERENT teams the agent is under, one includes, one excludes
    const b = set([{ skill: 'x', scope: 'team', team: 'cpp-architect' }, { skill: 'x', scope: 'team', team: 'top-leader', mode: 'exclude' }])
    expect(names(resolveSkillSet(b, ctx({ teams: ['cpp-architect', 'top-leader'] }), lib('x')))).toEqual([])
    expect(names(resolveSkillSet(b, ctx({ teams: ['top-leader', 'cpp-architect'] }), lib('x')))).toEqual([])
  })

  it('the scope levels are strictly increasing from global to agent-project', () => {
    const order = ['global', 'project', 'team', 'agent', 'agent-project'] as const
    for (let i = 1; i < order.length; i++) expect(SCOPE_LEVEL[order[i]]).toBeGreaterThan(SCOPE_LEVEL[order[i - 1]])
  })
})

describe('resolveSkillSet: the library', () => {
  it('a skill that is assigned but not in the library is reported as missing and not given', () => {
    const s = set([{ skill: 'here', scope: 'global' }, { skill: 'gone', scope: 'global' }, { skill: 'gone2', scope: 'agent', agent: 'cpp-developer' }])
    const r = resolveSkillSet(s, ctx(), lib('here'))
    expect(names(r)).toEqual(['here'])
    expect(r.missing).toEqual(['gone', 'gone2'])
  })

  it('a missing skill that is excluded is not reported (nobody was going to get it)', () => {
    const s = set([{ skill: 'gone', scope: 'global' }, { skill: 'gone', scope: 'agent', agent: 'cpp-developer', mode: 'exclude' }])
    expect(resolveSkillSet(s, ctx(), lib()).missing).toEqual([])
  })

  it('a library skill nobody assigned is given to nobody: the library is a stock, not a grant', () => {
    expect(names(resolveSkillSet(set([]), ctx(), lib('a', 'b')))).toEqual([])
  })

  it('does not mutate its input', () => {
    const s = set([{ skill: 'b', scope: 'global' }, { skill: 'a', scope: 'global' }])
    const before = JSON.stringify(s)
    resolveSkillSet(s, ctx(), lib('a', 'b'))
    expect(JSON.stringify(s)).toBe(before)
  })
})
