// The Projects page joins what the cards say with how the project is registered. These tests pin the join: the
// match is by name regardless of case, a registered project with no card is still listed, an unregistered one is
// shown as such, and the page gets the repo's NAME, never its path.

import { describe, it, expect, beforeEach } from 'vitest'
import { joinProjectOverview, repoName, type OverviewBase } from '../projects-overview.js'
import { normalizeProjectRegistry } from '../projects.js'
import { initDatabase, createKanbanCard, upsertKanbanProjectDescription, getKanbanProjectDescription, listKanbanProjectSummaries } from '../db.js'

const summary = (project: string, over: Partial<OverviewBase> = {}): OverviewBase => ({
  project, cardTotal: 3, cardDone: 1, lastActivityAt: 100, activeAssignees: ['a'], description: 'd', descriptionUpdatedAt: 5, ...over,
})

function registry(projects: Record<string, object>) {
  return normalizeProjectRegistry({ projects })
}

const worktree = (extra: object = {}) => ({
  repoPath: '/srv/git/the-repo', mode: 'worktree', baseBranch: 'main', workspaceRoot: '/srv/ws', maxParallel: 3, ...extra,
})

describe('repoName', () => {
  it('is the last path segment, with or without a trailing slash', () => {
    expect(repoName('/home/x/repo')).toBe('repo')
    expect(repoName('/home/x/repo/')).toBe('repo')
    expect(repoName('C:\\work\\repo')).toBe('repo')
  })
})

describe('joinProjectOverview', () => {
  it('attaches the registration to the matching summary, matched by name in any case', () => {
    const reg = registry({ 'Ticket-Test': worktree() })
    const [row] = joinProjectOverview([summary('ticket-test')], reg, () => 2)
    expect(row.registration).toEqual({
      mode: 'worktree', repo: 'the-repo', baseBranch: 'main', maxParallel: 3, isolated: true, activeTickets: 2,
    })
    expect(row.cardTotal).toBe(3)
    expect(row.description).toBe('d')
  })

  it('never carries the repository path, only its name', () => {
    const reg = registry({ p: worktree() })
    const text = JSON.stringify(joinProjectOverview([summary('p')], reg, () => 0))
    expect(text).not.toContain('/srv/git')
    expect(text).not.toContain('/srv/ws')
  })

  it('shows an unregistered project as having no registration', () => {
    const [row] = joinProjectOverview([summary('other')], registry({ p: worktree() }), () => 0)
    expect(row.project).toBe('other')
    expect(row.registration).toBeNull()
  })

  it('lists a registered project that has no card, after the others, with zero cards', () => {
    const reg = registry({ zeta: worktree(), alpha: worktree() })
    const rows = joinProjectOverview([summary('board-only')], reg, () => 0)
    expect(rows.map((r) => r.project)).toEqual(['board-only', 'alpha', 'zeta'])
    const alpha = rows[1]
    expect(alpha.cardTotal).toBe(0)
    expect(alpha.cardDone).toBe(0)
    expect(alpha.activeAssignees).toEqual([])
    expect(alpha.registration?.mode).toBe('worktree')
  })

  it('does not list a registered project twice when its card spells the name differently', () => {
    const rows = joinProjectOverview([summary('TICKET-test')], registry({ 'ticket-test': worktree() }), () => 0)
    expect(rows).toHaveLength(1)
  })

  it('counts workspaces only for an isolating project', () => {
    let asked = 0
    const reg = registry({ s: { repoPath: '/r/s', mode: 'shared' }, w: worktree() })
    const rows = joinProjectOverview([summary('s'), summary('w')], reg, () => { asked++; return 4 })
    expect(rows[0].registration).toMatchObject({ mode: 'shared', isolated: false, activeTickets: null })
    expect(rows[1].registration).toMatchObject({ isolated: true, activeTickets: 4 })
    expect(asked).toBe(1)
  })

  it('takes the stored description of a registered project that has no card', () => {
    const reg = registry({ quiet: worktree() })
    const [row] = joinProjectOverview([], reg, () => 0, (n) => (n === 'quiet' ? { description: 'waiting for the first ticket', updatedAt: 9 } : null))
    expect(row.description).toBe('waiting for the first ticket')
    expect(row.descriptionUpdatedAt).toBe(9)
  })

  it('is empty with neither cards nor registrations', () => {
    expect(joinProjectOverview([], registry({}), () => 0)).toEqual([])
  })
})

describe('getKanbanProjectDescription', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns the stored text, and null for a project with none', () => {
    expect(getKanbanProjectDescription('p')).toBeNull()
    upsertKanbanProjectDescription('p', ' about p ')
    expect(getKanbanProjectDescription('p')?.description).toBe('about p')
  })

  it('works for a project without any card, which the summaries do not list', () => {
    upsertKanbanProjectDescription('cardless', 'text')
    expect(listKanbanProjectSummaries()).toEqual([])
    expect(getKanbanProjectDescription('cardless')?.description).toBe('text')
  })

  it('is found whatever the casing of the name, so the registry spelling meets the board spelling', () => {
    upsertKanbanProjectDescription('Ticket-Test', 'about it')
    expect(getKanbanProjectDescription('ticket-test')?.description).toBe('about it')
    expect(getKanbanProjectDescription('TICKET-TEST')?.description).toBe('about it')
  })

  it('a row whose description was emptied is still returned (an empty text), not treated as absent', () => {
    upsertKanbanProjectDescription('p', 'text')
    upsertKanbanProjectDescription('p', '')
    expect(getKanbanProjectDescription('p')).toMatchObject({ description: '' })
  })

  it('goes together with the summaries for a project that has cards', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'p' })
    const rows = joinProjectOverview(listKanbanProjectSummaries(), registry({ p: worktree() }), () => 0)
    expect(rows).toHaveLength(1)
    expect(rows[0].cardTotal).toBe(1)
  })
})

