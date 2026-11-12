// Copy today's shared skills into the skill library and give each a `global` assignment (docs/skill-konyvtar.md).
//
//   npx tsx scripts/skill-library-import.ts                 # dry run: what would be copied, and why the rest is not
//   npx tsx scripts/skill-library-import.ts --apply         # do it
//   --shared <dir>  --library <dir>  --assignments <file>   # override the defaults
//
// Copies only: the shared directory is not changed, so agents still on `skillsMode: shared` keep working.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../src/config.js'
import { applySkillMigration, planSkillMigration } from '../src/skill-migration.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const shared = arg('--shared', join(homedir(), '.claude', 'skills'))
const library = arg('--library', join(PROJECT_ROOT, 'store', 'skill-library'))
const assignments = arg('--assignments', join(PROJECT_ROOT, 'store', 'skill-assignments.json'))
const apply = process.argv.includes('--apply')

const plan = planSkillMigration(shared, library, assignments)
console.log(`shared:      ${shared}\nlibrary:     ${library}\nassignments: ${assignments}\n`)
if (plan.assignmentsError) {
  console.error(`The assignments file cannot be used (${plan.assignmentsError}). Nothing is written; fix or move it first.`)
  process.exit(1)
}
console.log(`to copy (${plan.copy.length}): ${plan.copy.join(', ') || '-'}`)
for (const s of plan.skipped) console.log(`skipped: ${s.entry}: ${s.reason}`)
if (plan.unassigned.length) console.log(`in the library but with no assignment (left alone): ${plan.unassigned.join(', ')}`)

if (!apply) { console.log('\nDry run. Add --apply to copy and assign.'); process.exit(0) }
const r = applySkillMigration(plan, shared, library, assignments)
console.log(`\ncopied ${r.copied.length}, assigned global ${r.assigned.length}`)
for (const s of r.skippedInside) console.log(`not copied (a link or special file inside a skill): ${s}`)
for (const f of r.failed) console.error(`FAILED ${f.skill}: ${f.error}`)
process.exit(r.failed.length ? 1 : 0)
