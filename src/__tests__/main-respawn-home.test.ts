// docs/sajat-claude-home.md: the main session is never respawned without the instance's own Claude home (it would come
// up with no CLAUDE_CONFIG_DIR, i.e. on the host ~/.claude), and a respawn without a mode's own dir exports the home.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { useInstanceHome } from './helpers/instance-home.js'
import { mainRespawnHomeReady, buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

let dir = ''
let restore: () => void = () => {}
afterEach(() => { restore(); restore = () => {}; if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('mainRespawnHomeReady', () => {
  it('no home: refused (false), nothing created', () => {
    dir = mkdtempSync(join(tmpdir(), 'respawn-home-'))
    const prev = process.env.NESTOR_CLAUDE_HOME
    process.env.NESTOR_CLAUDE_HOME = join(dir, 'missing')
    restore = () => { if (prev === undefined) delete process.env.NESTOR_CLAUDE_HOME; else process.env.NESTOR_CLAUDE_HOME = prev }
    expect(mainRespawnHomeReady()).toBe(false)
  })
  it('with a home: ready', () => {
    dir = mkdtempSync(join(tmpdir(), 'respawn-home-'))
    restore = useInstanceHome(join(dir, 'home'))
    expect(mainRespawnHomeReady()).toBe(true)
  })
})

describe('buildMainSessionRespawnCmd without a mode dir', () => {
  it('exports CLAUDE_CONFIG_DIR and NESTOR_CLAUDE_HOME = the instance home, never an empty config dir', () => {
    const cmd = buildMainSessionRespawnCmd({
      claudePath: '/bin/claude', pluginId: 'telegram@x', model: 'opus', continueSession: false,
      config: mainConfigDecisionForTest({ isolatedConfigDir: null, fleetToken: false }),
      instanceHome: '/srv/a/.claude-home',
      channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/srv/a/.claude/channels/telegram' },
    })
    expect(cmd).toContain("export CLAUDE_CONFIG_DIR='/srv/a/.claude-home'")
    expect(cmd).toContain("export NESTOR_CLAUDE_HOME='/srv/a/.claude-home'")
  })
})
