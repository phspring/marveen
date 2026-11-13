import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// An agent reads a seeded SKILL.md as raw text, not as rendered Markdown. A command written inside a Markdown table
// has to escape its pipes (`a \|\| b`), and copied from the raw file the backslashes stay in the shell command:
// `git symbolic-ref ... \|\| echo origin/develop` runs `|` as a literal argument instead of the fallback
// (found by Copilot on #17, code-security-review). Commands belong in a fenced block, where a pipe needs no escape.

const ROOT = join(__dirname, '..', '..')
const SHIPPED = ['seed-skills', 'seed-scheduled-tasks']

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...markdownFiles(p))
    else if (entry.endsWith('.md')) out.push(p)
  }
  return out
}

/** Inline code spans (`...`) outside fenced blocks that contain an escaped pipe. */
function escapedPipesInCode(text: string): string[] {
  const hits: string[] = []
  let fenced = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return }
    if (fenced) return
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (m[1].includes('\\|')) hits.push(`${i + 1}: ${m[1]}`)
    }
  })
  return hits
}

describe('seeded Markdown: no table-escaped pipes inside commands', () => {
  it('detects an escaped pipe in an inline code span, ignores fenced blocks and plain table pipes', () => {
    expect(escapedPipesInCode('| a | `x \\|\\| y` |')).toEqual(['1: x \\|\\| y'])
    expect(escapedPipesInCode('```\nx \\|\\| y\n```')).toEqual([])
    expect(escapedPipesInCode('| a | `x` | b |')).toEqual([])
  })

  for (const dir of SHIPPED) {
    it(`${dir}: every shipped .md`, () => {
      const bad: string[] = []
      for (const f of markdownFiles(join(ROOT, dir))) {
        for (const h of escapedPipesInCode(readFileSync(f, 'utf-8'))) bad.push(`${relative(ROOT, f)}:${h}`)
      }
      expect(bad).toEqual([])
    })
  }
})
