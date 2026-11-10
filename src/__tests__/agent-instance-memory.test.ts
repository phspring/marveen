import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  // Copilot finding on PR #6: only top-level symlinks were skipped, while subdirectories were copied recursively with
  // whatever they contained, so a link nested in a subdirectory was archived into the template as a link.
  it('never archives a symlink at any depth: a link nested in a subdirectory, to a file or to a directory, stays out', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    mkdirSync(join(base, 'outside-dir'))
    writeFileSync(join(base, 'outside-dir', 'secret.txt'), 'outside\n')
    writeFileSync(join(base, 'secret.txt'), 'outside\n')
    mkdirSync(join(r.dir, 'memory', 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(r.dir, 'memory', 'sub', 'kept.md'), 'kept\n')
    writeFileSync(join(r.dir, 'memory', 'sub', 'deeper', 'kept-too.md'), 'kept too\n')
    symlinkSync(join(base, 'secret.txt'), join(r.dir, 'memory', 'sub', 'link-to-file.md'))
    symlinkSync(join(base, 'outside-dir'), join(r.dir, 'memory', 'sub', 'link-to-dir'))
    symlinkSync(join(base, 'secret.txt'), join(r.dir, 'memory', 'sub', 'deeper', 'deep-link.md'))

    expect(archiveInstanceMemory(base, r.name).ok).toBe(true)
    const dest = join(tpl, 'memory', 'tickets', 'TVR-9')
    expect(readFileSync(join(dest, 'sub', 'kept.md'), 'utf-8')).toBe('kept\n')
    expect(readFileSync(join(dest, 'sub', 'deeper', 'kept-too.md'), 'utf-8')).toBe('kept too\n')
    const links: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (lstatSync(p).isSymbolicLink()) links.push(p)
        else if (lstatSync(p).isDirectory()) walk(p)
      }
    }
    walk(dest)
    expect(links).toEqual([])
    expect(existsSync(join(dest, 'sub', 'link-to-file.md'))).toBe(false)
    expect(existsSync(join(dest, 'sub', 'link-to-dir'))).toBe(false)
    expect(existsSync(join(dest, 'sub', 'deeper', 'deep-link.md'))).toBe(false)
  })

  it('copies only regular files and directories: a FIFO in the memory is skipped', () => {
    const tpl = makeTemplate()
    const r = createAgentInstance(base, 'cpp-developer', 'TVR-9')
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'memory', 'real.md'), 'real\n')
    mkdirSync(join(r.dir, 'memory', 'sub'))
    execFileSync('mkfifo', [join(r.dir, 'memory', 'sub', 'pipe')])
    expect(archiveInstanceMemory(base, r.name).ok).toBe(true)
    const dest = join(tpl, 'memory', 'tickets', 'TVR-9')
    expect(readFileSync(join(dest, 'real.md'), 'utf-8')).toBe('real\n')
    expect(existsSync(join(dest, 'sub', 'pipe'))).toBe(false)
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
