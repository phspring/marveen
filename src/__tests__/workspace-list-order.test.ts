import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectRegistry, type ProjectConfig } from '../projects.js'
import { listWorkspaces, orphanWorkspaces, projectSlug } from '../web/workspace.js'

let root: string
let proj: ProjectConfig

function marker(ticket: string, createdAt: string): void {
  const dir = join(root, '.marveen-workspaces', projectSlug(proj.name))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${ticket}.json`), JSON.stringify({
    project: proj.name, ticket, kind: 'worktree', repoPath: '/r/app', path: join(root, projectSlug(proj.name), ticket),
    branch: `feature/${ticket}`, baseBranch: 'develop', createdAt,
  }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-order-'))
  proj = normalizeProjectRegistry({ projects: { p: { repoPath: '/r/app', mode: 'worktree', workspaceRoot: root, maxParallel: 9 } } }).projects[0]
})
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* temp */ } })

describe('listWorkspaces order', () => {
  it('is oldest first by createdAt, not by file name', () => {
    // the file names sort the other way round to the creation times
    marker('A-late', '2026-03-01T00:00:00.000Z')
    marker('B-mid', '2026-02-01T00:00:00.000Z')
    marker('C-early', '2026-01-01T00:00:00.000Z')
    expect(listWorkspaces(proj).map((m) => m.ticket)).toEqual(['C-early', 'B-mid', 'A-late'])
  })

  it('breaks ties by ticket id and keeps unreadable creation times first and stable', () => {
    marker('T-2', '2026-01-01T00:00:00.000Z')
    marker('T-1', '2026-01-01T00:00:00.000Z')
    marker('T-0', 'not a date')
    expect(listWorkspaces(proj).map((m) => m.ticket)).toEqual(['T-0', 'T-1', 'T-2'])
  })

  it('orphans keep the same order', () => {
    marker('A', '2026-03-01T00:00:00.000Z')
    marker('B', '2026-01-01T00:00:00.000Z')
    marker('C', '2026-02-01T00:00:00.000Z')
    expect(orphanWorkspaces(proj, ['C']).map((m) => m.ticket)).toEqual(['B', 'A'])
  })
})
