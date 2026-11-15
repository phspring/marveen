// GLOBAL SUITE SEAM: no test may write the CHECKOUT's instance Claude home by default (docs/sajat-claude-home.md).
//
// The instance home resolves to <PROJECT_ROOT>/.claude-home when NESTOR_CLAUDE_HOME is unset. A test that only redirects
// HOME (the old way to sandbox the shared ~/.claude) therefore wrote into the repo checkout: measured on the first
// full run of the instance-home branch, 13 files seeded scheduled tasks and a .removed-defaults tombstone into
// <worktree>/.claude-home, and one of them (scheduled-task-deletion-tombstone) went red only because a parallel file
// had written the shared tombstone meanwhile -- green alone, red in the suite. On a live install's checkout it would
// write the instance's real home.
//
// Same shape as default-ssh-dir-seam.ts, for the same reasons: a setupFile (every worker, before any test module
// imports, so modules that resolve the home at import see it), a bounded per-pool-slot directory cleared on ENTRY
// (no per-file mkdtemp leak, no reliance on an exit hook), and an existing NESTOR_CLAUDE_HOME is respected, so a
// test that wants its own home (useInstanceHome) keeps it. The dir gets NO marker: a test that needs a real home
// makes one; one that tests the missing-home refusal sets its own path.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.NESTOR_CLAUDE_HOME) {
  const slot = (process.env.VITEST_POOL_ID || String(process.pid)).replace(/[^A-Za-z0-9_-]/g, '_')
  const seamDir = join(tmpdir(), 'nestor-claude-home-seam', `w${slot}`)
  rmSync(seamDir, { recursive: true, force: true })
  mkdirSync(seamDir, { recursive: true })
  process.env.NESTOR_CLAUDE_HOME = seamDir
}
