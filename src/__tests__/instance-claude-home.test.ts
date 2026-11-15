// docs/sajat-claude-home.md, the instance side: describeInstance takes the home from the .env text it is given (so
// `nestor doctor` sees a NESTOR_CLAUDE_HOME two installs share), and a shared home is an error, not a warning.
import { describe, it, expect } from 'vitest'
import { describeInstance, findConflicts } from '../instance.js'

const H = '/home/u'

describe('the instance home in describeInstance / doctor', () => {
  it('default: <root>/.claude-home; a NESTOR_CLAUDE_HOME in the given .env text wins', () => {
    expect(describeInstance('/srv/a', 'MAIN_AGENT_ID=a\n', H).claudeConfig).toBe('/srv/a/.claude-home')
    expect(describeInstance('/srv/a', 'MAIN_AGENT_ID=a\nNESTOR_CLAUDE_HOME=/data/a-home\n', H).claudeConfig).toBe('/data/a-home')
  })

  it('two installs pointed at one home: an error', () => {
    const a = describeInstance('/srv/a', 'MAIN_AGENT_ID=a\nSERVICE_ID=a\nWEB_PORT=3501\nNESTOR_CLAUDE_HOME=/data/shared\n', H)
    const b = describeInstance('/srv/b', 'MAIN_AGENT_ID=b\nSERVICE_ID=b\nWEB_PORT=3502\nNESTOR_CLAUDE_HOME=/data/shared\n', H)
    const c = findConflicts(a, b).find((x: { what?: string; level: string; detail?: string }) => JSON.stringify(x).includes('/data/shared'))
    expect(c?.level).toBe('error')
  })

  it('each with its own home: no Claude-config conflict', () => {
    const a = describeInstance('/srv/a', 'MAIN_AGENT_ID=a\nSERVICE_ID=a\nWEB_PORT=3501\n', H)
    const b = describeInstance('/srv/b', 'MAIN_AGENT_ID=b\nSERVICE_ID=b\nWEB_PORT=3502\n', H)
    expect(findConflicts(a, b).filter((x: object) => JSON.stringify(x).includes('Claude config'))).toEqual([])
  })
})
