import { describe, it, expect } from 'vitest'
import { normalizeExternalRef, normalizeScopeField, parseScopeText, MAX_SCOPE_ENTRIES } from '../kanban-ticket-fields.js'

describe('normalizeExternalRef', () => {
  it('accepts ticket references and trims them', () => {
    expect(normalizeExternalRef('TVR-2658')).toEqual({ ok: true, value: 'TVR-2658' })
    expect(normalizeExternalRef('  tvr-1 ')).toEqual({ ok: true, value: 'tvr-1' })
    expect(normalizeExternalRef('GH#123')).toEqual({ ok: true, value: 'GH#123' })
    expect(normalizeExternalRef('a.b_c-1')).toEqual({ ok: true, value: 'a.b_c-1' })
  })
  it('null, undefined and blank clear the field', () => {
    for (const v of [null, undefined, '', '   ']) expect(normalizeExternalRef(v)).toEqual({ ok: true, value: null })
  })
  it('refuses anything that could not be a directory or branch name', () => {
    for (const v of ['../x', 'a/b', 'a b', '-x', '.x', 'a..b', 'a.', 'a.lock', 'x'.repeat(65), 'tvr\u0000', 3, {}, []]) {
      expect(normalizeExternalRef(v).ok, JSON.stringify(v)).toBe(false)
    }
  })
})

describe('normalizeScopeField', () => {
  it('turns a list into one clean prefix per line', () => {
    expect(normalizeScopeField(['src/games/', './src/menu', 'src/games'])).toEqual({ ok: true, value: 'src/games\nsrc/menu' })
  })
  it('accepts the stored text back (the dashboard round trip) with either line ending', () => {
    expect(normalizeScopeField('src/games\r\nsrc/menu\n')).toEqual({ ok: true, value: 'src/games\nsrc/menu' })
  })
  it('null, blank and empty lists clear the field', () => {
    for (const v of [null, undefined, '', '  \n ', [], ['', '  ']]) expect(normalizeScopeField(v)).toEqual({ ok: true, value: null })
  })
  it('refuses an entry that is not repo-relative instead of silently dropping it', () => {
    for (const v of [['src', '/etc'], ['../x'], ['a/../b'], 'src\n/abs']) {
      const r = normalizeScopeField(v)
      expect(r.ok, JSON.stringify(v)).toBe(false)
    }
  })
  it('refuses non-text entries, too many entries and very long entries', () => {
    expect(normalizeScopeField([1 as never]).ok).toBe(false)
    expect(normalizeScopeField(3).ok).toBe(false)
    expect(normalizeScopeField(Array.from({ length: MAX_SCOPE_ENTRIES + 1 }, (_, i) => `p${i}`)).ok).toBe(false)
    expect(normalizeScopeField(['x'.repeat(201)]).ok).toBe(false)
  })
})

describe('parseScopeText', () => {
  it('reads the stored text as the prefix list, and null as "not declared"', () => {
    expect(parseScopeText('src/games\nsrc/menu')).toEqual(['src/games', 'src/menu'])
    for (const v of [null, undefined, '', '\n']) expect(parseScopeText(v)).toBeNull()
  })
  it('round trips what normalizeScopeField stores', () => {
    const stored = normalizeScopeField(['src/b', 'src/a'])
    expect(stored.ok && parseScopeText(stored.value)).toEqual(['src/b', 'src/a'])
  })
})
