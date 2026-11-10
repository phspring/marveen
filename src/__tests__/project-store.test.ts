import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectRegistry } from '../web/project-store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'proj-store-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } })

describe('readProjectRegistry', () => {
  it('a missing file is the normal empty registry, with no problem', () => {
    expect(readProjectRegistry(join(dir, 'projects.json'))).toEqual({ projects: [], problems: [] })
  })

  it('a file that is not JSON is empty, and the problem names the file that was actually read', () => {
    const p = join(dir, 'custom-name.json')
    writeFileSync(p, '{ not json')
    const r = readProjectRegistry(p)
    expect(r.projects).toEqual([])
    expect(r.problems).toEqual([`${p} is not valid JSON`])
  })

  it('reads and normalises a valid file', () => {
    const p = join(dir, 'projects.json')
    writeFileSync(p, JSON.stringify({ projects: { a: { repoPath: '/r/a', jiraKeys: ['abc'] } } }))
    const r = readProjectRegistry(p)
    expect(r.projects).toHaveLength(1)
    expect(r.projects[0]).toMatchObject({ name: 'a', mode: 'shared', jiraKeys: ['ABC'] })
  })

  it('a registry that names a project badly reports the problem and keeps the rest', () => {
    const p = join(dir, 'projects.json')
    writeFileSync(p, JSON.stringify({ projects: { bad: { repoPath: 'relative' }, good: { repoPath: '/r/g' } } }))
    const r = readProjectRegistry(p)
    expect(r.projects.map((x) => x.name)).toEqual(['good'])
    expect(r.problems.length).toBe(1)
  })
})
