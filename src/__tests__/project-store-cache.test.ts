// The registry is read on every dispatch and every reconcile pass: the same text must cost one parse and one warning,
// and an edit must apply at once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), error: vi.fn() } }))

import { readProjectRegistry } from '../web/project-store.js'

let dir: string
let file: string
beforeEach(() => { warn.mockClear(); dir = mkdtempSync(join(tmpdir(), 'proj-cache-')); file = join(dir, 'projects.json') })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } })

const registry = (projects: Record<string, unknown>) => JSON.stringify({ projects })

describe('readProjectRegistry: the same text is read once', () => {
  it('a problem in the registry is logged once however often it is read', () => {
    writeFileSync(file, registry({ bad: { repoPath: 'relative' }, ok: { repoPath: '/r/ok' } }))
    for (let i = 0; i < 20; i++) expect(readProjectRegistry(file).projects.map((p) => p.name)).toEqual(['ok'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('invalid JSON is logged once, and stays empty', () => {
    writeFileSync(file, '{ nope')
    for (let i = 0; i < 5; i++) expect(readProjectRegistry(file).projects).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns the very same registry object for the same text (no re-parse)', () => {
    writeFileSync(file, registry({ a: { repoPath: '/r/a' } }))
    expect(readProjectRegistry(file)).toBe(readProjectRegistry(file))
  })

  it('an edit applies on the next read, and a new problem is logged', () => {
    writeFileSync(file, registry({ a: { repoPath: '/r/a' } }))
    expect(readProjectRegistry(file).projects.map((p) => p.name)).toEqual(['a'])
    writeFileSync(file, registry({ a: { repoPath: '/r/a' }, b: { repoPath: 'relative' } }))
    expect(readProjectRegistry(file).projects.map((p) => p.name)).toEqual(['a'])
    expect(warn).toHaveBeenCalledTimes(1)
    writeFileSync(file, registry({ b: { repoPath: '/r/b' } }))
    expect(readProjectRegistry(file).projects.map((p) => p.name)).toEqual(['b'])
  })

  it('a file that disappears is the empty registry, and coming back is read again', () => {
    writeFileSync(file, registry({ a: { repoPath: '/r/a' } }))
    expect(readProjectRegistry(file).projects).toHaveLength(1)
    unlinkSync(file)
    expect(readProjectRegistry(file)).toEqual({ projects: [], problems: [] })
    writeFileSync(file, registry({ a: { repoPath: '/r/a' } }))
    expect(readProjectRegistry(file).projects).toHaveLength(1)
  })
})
