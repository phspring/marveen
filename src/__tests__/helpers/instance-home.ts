// Test helper for the instance's own Claude home (src/claude-home.ts). The provisioners' shared root used to be the
// host ~/.claude, so tests seeded a fake `<HOME>/.claude`. Now it is the instance home: a test makes one with the
// marker and points NESTOR_CLAUDE_HOME at it (the resolver's env seam, read at call time).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MARKER = '.nestor-claude-home'

/** Create `dir` as an instance home (with the marker) and return it. */
export function makeInstanceHome(dir: string, root = '/test-install'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARKER), JSON.stringify({ root }) + '\n')
  return dir
}

/** makeInstanceHome + NESTOR_CLAUDE_HOME pointing at it. Returns a restore function for afterEach. */
export function useInstanceHome(dir: string, root?: string): () => void {
  const prev = process.env.NESTOR_CLAUDE_HOME
  makeInstanceHome(dir, root)
  process.env.NESTOR_CLAUDE_HOME = dir
  return () => {
    if (prev === undefined) delete process.env.NESTOR_CLAUDE_HOME
    else process.env.NESTOR_CLAUDE_HOME = prev
  }
}
