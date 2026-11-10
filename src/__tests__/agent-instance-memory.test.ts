import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentInstance, archiveInstanceMemory } from '../web/agent-instance.js'

let base: string

function makeTemplate(): string {
  const dir = join(base, 'cpp-developer')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ model: 'm', team: { role: 'member', reportsTo: 'lead' } }))
  writeFileSync(join(dir, 'CLAUDE.md'), '# cpp-developer\n')
  writeFileSync(join(dir, 'memory', 'own-note.md'), 'the template\'s own note\n')
  return dir
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'inst-mem-')) })
afterEach(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* temp */ } })

describe('archiveInstanceMemory', () => {
  it('copies what the instance wrote to the template under memory/tickets/<ticket>/, beside the template\'s own notes', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'memory', 'learned.md'), 'a quirk of the build\n')
    mkdirSync(join(r.dir, 'memory', 'sub'))
    writeFileSync(join(r.dir, 'memory', 'sub', 'detail.md'), 'detail\n')

    const a = archiveInstanceMemory(base, r.name)
    expect(a).toMatchObject({ ok: true, archived: 2, to: join(tpl, 'memory', 'tickets', 'TVR-9') })
    expect(readFileSync(join(tpl, 'memory', 'tickets', 'TVR-9', 'learned.md'), 'utf-8')).toBe('a quirk of the build\n')
    expect(readFileSync(join(tpl, 'memory', 'tickets', 'TVR-9', 'sub', 'detail.md'), 'utf-8')).toBe('detail\n')
    // the template's own note is untouched
    expect(readFileSync(join(tpl, 'memory', 'own-note.md'), 'utf-8')).toBe('the template\'s own note\n')
  })

  it('an instance that wrote nothing archives nothing (the empty MEMORY.md it started with is not memory)', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    expect(archiveInstanceMemory(base, r.name)).toEqual({ ok: true, archived: 0, to: null })
    expect(existsSync(join(tpl, 'memory', 'tickets'))).toBe(false)
  })

  it('a MEMORY.md the instance filled IS archived', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'memory', 'MEMORY.md'), '- learned something\n')
    expect(archiveInstanceMemory(base, r.name)).toMatchObject({ ok: true, archived: 1 })
    expect(readFileSync(join(tpl, 'memory', 'tickets', 'TVR-9', 'MEMORY.md'), 'utf-8')).toBe('- learned something\n')
  })

  it('never overwrites a file already archived, and never follows a symlink out of the instance', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    mkdirSync(join(tpl, 'memory', 'tickets', 'TVR-9'), { recursive: true })
    writeFileSync(join(tpl, 'memory', 'tickets', 'TVR-9', 'learned.md'), 'earlier archive\n')
    writeFileSync(join(r.dir, 'memory', 'learned.md'), 'newer text\n')
    writeFileSync(join(base, 'secret.txt'), 'outside\n')
    symlinkSync(join(base, 'secret.txt'), join(r.dir, 'memory', 'leak.md'))

    archiveInstanceMemory(base, r.name)
    expect(readFileSync(join(tpl, 'memory', 'tickets', 'TVR-9', 'learned.md'), 'utf-8')).toBe('earlier archive\n')
    expect(readdirSync(join(tpl, 'memory', 'tickets', 'TVR-9'))).not.toContain('leak.md')
  })

  it('refuses anything that is not an instance, a bad name, and a missing template', () => {
    makeTemplate()
    expect(archiveInstanceMemory(base, 'cpp-developer').ok).toBe(false)
    expect(archiveInstanceMemory(base, '../x').ok).toBe(false)
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'memory', 'a.md'), 'x\n')
    rmSync(join(base, 'cpp-developer'), { recursive: true, force: true })
    expect(archiveInstanceMemory(base, r.name).ok).toBe(false)
  })
})
