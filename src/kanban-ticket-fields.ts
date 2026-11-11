// The two card fields the ticket environments read (docs/jegy-kornyezet.md): `external_ref` (the ticket's id in the
// tracker, e.g. "TVR-2658") and `scope` (the repo-relative path prefixes the ticket will touch). Pure validation and
// conversion, shared by the HTTP boundary and the dispatch, so both read the stored text the same way.
//
// Stored as plain text so every existing read path (SELECT *, the dashboard's whole-card round trip) carries them
// unchanged: `external_ref` is one line, `scope` is one prefix per line.

import { normalizeScope } from './workspace-decision.js'

export const MAX_SCOPE_ENTRIES = 50
export const MAX_SCOPE_ENTRY_LENGTH = 200
const REF_RX = /^[A-Za-z0-9][A-Za-z0-9._#-]{0,63}$/

export type FieldResult = { ok: true; value: string | null } | { ok: false; error: string }

/** null / '' clears the field; otherwise a reference of a safe shape (it becomes a directory and a branch name). */
export function normalizeExternalRef(v: unknown): FieldResult {
  if (v === null || v === undefined) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: 'external_ref must be a string (e.g. "TVR-2658") or null' }
  const t = v.trim()
  if (t === '') return { ok: true, value: null }
  if (!REF_RX.test(t) || t.includes('..') || t.endsWith('.') || t.endsWith('.lock')) {
    return { ok: false, error: 'external_ref must be a ticket reference such as "TVR-2658" (letters, digits, . _ # -; at most 64 characters)' }
  }
  return { ok: true, value: t }
}

/**
 * The scope as the text the column stores: one clean repo-relative prefix per line, or null. Accepts an array of
 * strings or the text itself (the dashboard sends the stored text back). An entry that is not repo-relative is an
 * error, never silently dropped: a scope that quietly lost an entry would make the overlap check trust less than the
 * author wrote.
 */
export function normalizeScopeField(v: unknown): FieldResult {
  if (v === null || v === undefined) return { ok: true, value: null }
  let entries: unknown[]
  if (Array.isArray(v)) entries = v
  else if (typeof v === 'string') entries = v.split(/\r?\n/)
  else return { ok: false, error: 'scope must be a list of path prefixes (or one per line), or null' }

  const nonEmpty = entries.filter((e) => !(typeof e === 'string' && e.trim() === ''))
  if (nonEmpty.length === 0) return { ok: true, value: null }
  if (nonEmpty.length > MAX_SCOPE_ENTRIES) return { ok: false, error: `scope can hold at most ${MAX_SCOPE_ENTRIES} entries` }
  if (nonEmpty.some((e) => typeof e !== 'string' || e.length > MAX_SCOPE_ENTRY_LENGTH)) {
    return { ok: false, error: `every scope entry must be a string of at most ${MAX_SCOPE_ENTRY_LENGTH} characters` }
  }
  const cleaned = normalizeScope(nonEmpty)
  const kept = cleaned ? cleaned.length : 0
  // normalizeScope drops invalid entries and merges duplicates; tell the caller when something was invalid
  const invalid = (nonEmpty as string[]).filter((e) => normalizeScope([e]) === null)
  if (invalid.length > 0) {
    return { ok: false, error: `scope entries must be repo-relative paths without "..": ${invalid.slice(0, 3).map((e) => JSON.stringify(e)).join(', ')}` }
  }
  return kept > 0 ? { ok: true, value: (cleaned as string[]).join('\n') } : { ok: true, value: null }
}

/** The stored scope text as the prefix list the dispatch decision takes (null: not declared). */
export function parseScopeText(text: string | null | undefined): string[] | null {
  if (typeof text !== 'string') return null
  return normalizeScope(text.split(/\r?\n/))
}
