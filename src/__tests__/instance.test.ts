// What an instance owns, and where two would share something (src/instance.ts), plus the machine's list of
// instances (src/instance-registry.ts) and the CLI over both.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conflictsWithOthers, describeInstance, findConflicts } from '../instance.js'
import { readRegistry, registerInstance, registryDir, unregisterInstance } from '../instance-registry.js'
import { runInstanceCli } from '../instance-cli.js'

const HOME = '/home/u'
const inst = (root: string, env: string | null) => describeInstance(root, env, HOME)

describe('describeInstance', () => {
  it('without a .env every default applies', () => {
    const i = inst('/srv/a', null)
    expect(i).toMatchObject({
      unitId: 'marveen', mainAgentId: 'marveen', channelsSession: 'marveen-channels', port: 3420, host: '127.0.0.1',
      tmuxServer: 'default', ownClaudeConfig: false, claudeConfig: '/home/u/.claude', node: null,
    })
    expect(i.units).toEqual({ dashboard: 'marveen-dashboard', channels: 'marveen-channels' })
    expect(i.tokenPath).toBe('/srv/a/store/.claude-oauth-token')
    expect(i.dbPath).toBe('/srv/a/store/claudeclaw.db')
  })

  it('reads the port, the ids, the own Claude config and the tmux directory from the .env', () => {
    const i = inst('/srv/b', 'MAIN_AGENT_ID=nestor\nSERVICE_ID=nestor-dev\nWEB_PORT=3421\nMAIN_AGENT_ISOLATED_CONFIG=1\nTMUX_TMPDIR=/srv/b/store/tmux\nNESTOR_NODE=/opt/node22/bin/node\n')
    expect(i).toMatchObject({
      unitId: 'nestor-dev', mainAgentId: 'nestor', channelsSession: 'nestor-channels', port: 3421,
      tmuxServer: '/srv/b/store/tmux', ownClaudeConfig: true, claudeConfig: '/srv/b/.channels-config', node: '/opt/node22/bin/node',
    })
    expect(i.units.dashboard).toBe('nestor-dev-dashboard')
  })

  it('the service id falls back to the main agent id', () => {
    expect(inst('/srv/c', 'MAIN_AGENT_ID=ada').unitId).toBe('ada')
  })

  it('a bad port or id falls back to the default instead of being used', () => {
    expect(inst('/srv/d', 'WEB_PORT=99999').port).toBe(3420)
    expect(inst('/srv/d', 'WEB_PORT=abc').port).toBe(3420)
    expect(inst('/srv/d', 'MAIN_AGENT_ID=bad id; rm -rf').mainAgentId).toBe('marveen')
  })

  it('reads only its own keys: a secret in the .env is not in the description', () => {
    const i = inst('/srv/e', 'TELEGRAM_BOT_TOKEN=123456:SECRETVALUE\nANTHROPIC_API_KEY=sk-secret\nWEB_PORT=3500\n')
    expect(JSON.stringify(i)).not.toMatch(/SECRET|sk-secret/)
    expect(i.port).toBe(3500)
  })
})

describe('findConflicts', () => {
  const prod = inst('/var/www/marveen', 'MAIN_AGENT_ID=marveen\nWEB_PORT=3420\n')

  it('flags the same port and the same unit name as errors', () => {
    const c = findConflicts(prod, inst('/srv/x', 'MAIN_AGENT_ID=marveen\nWEB_PORT=3420\n'))
    expect(c.filter((x) => x.level === 'error').map((x) => x.what).sort()).toEqual(['port', 'service units'])
  })

  it('a dev install with its own port and service id still shares the default tmux server and session name', () => {
    const dev = inst('/home/u/nestor-dev', 'MAIN_AGENT_ID=marveen\nSERVICE_ID=nestor-dev\nWEB_PORT=3421\nMAIN_AGENT_ISOLATED_CONFIG=1\n')
    const c = findConflicts(prod, dev)
    expect(c.some((x) => x.level === 'error')).toBe(false)
    expect(c.map((x) => x.what).sort()).toEqual(['Claude config'.replace('Claude config', 'tmux server'), 'tmux session'].sort())
  })

  it('is clean for two instances that each own port, units, tmux directory, main agent and Claude config', () => {
    const a = inst('/srv/a', 'MAIN_AGENT_ID=a\nWEB_PORT=3420\nMAIN_AGENT_ISOLATED_CONFIG=1\nTMUX_TMPDIR=/srv/a/tmux\n')
    const b = inst('/srv/b', 'MAIN_AGENT_ID=b\nWEB_PORT=3421\nMAIN_AGENT_ISOLATED_CONFIG=1\nTMUX_TMPDIR=/srv/b/tmux\n')
    expect(findConflicts(a, b)).toEqual([])
  })

  it('two instances that both use the shared ~/.claude are told so', () => {
    const a = inst('/srv/a', 'MAIN_AGENT_ID=a\nWEB_PORT=3420\nTMUX_TMPDIR=/srv/a/tmux\n')
    const b = inst('/srv/b', 'MAIN_AGENT_ID=b\nWEB_PORT=3421\nTMUX_TMPDIR=/srv/b/tmux\n')
    expect(findConflicts(a, b).map((x) => x.what)).toEqual(['Claude config'])
  })

  it('the same install directory is one error and nothing else', () => {
    const c = findConflicts(prod, inst('/var/www/marveen', null))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ level: 'error', what: 'install directory' })
  })

  it('conflictsWithOthers skips the instance itself', () => {
    expect(conflictsWithOthers(prod, [prod])).toEqual([])
  })
})

describe('registry and CLI', () => {
  let base: string, reg: string, a: string, b: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'nestorreg-'))
    reg = join(base, 'reg'); a = join(base, 'a'); b = join(base, 'b')
    mkdirSync(a); mkdirSync(b)
    writeFileSync(join(a, '.env'), 'MAIN_AGENT_ID=alpha\nWEB_PORT=4100\nTMUX_TMPDIR=' + join(a, 'tmux') + '\nMAIN_AGENT_ISOLATED_CONFIG=1\n')
    writeFileSync(join(b, '.env'), 'MAIN_AGENT_ID=beta\nWEB_PORT=4100\nTMUX_TMPDIR=' + join(b, 'tmux') + '\nMAIN_AGENT_ISOLATED_CONFIG=1\n')
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const run = (args: string[]) => {
    const out: string[] = [], err: string[] = []
    const code = runInstanceCli(args, { NESTOR_REGISTRY_DIR: reg }, (s) => out.push(s), (s) => err.push(s), '/home/u')
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('registryDir honours the override and XDG_CONFIG_HOME', () => {
    expect(registryDir({ NESTOR_REGISTRY_DIR: '/x/y' }, '/h')).toBe('/x/y')
    expect(registryDir({ XDG_CONFIG_HOME: '/xdg' }, '/h')).toBe('/xdg/nestor/instances')
    expect(registryDir({}, '/h')).toBe('/h/.config/nestor/instances')
  })

  it('two installs with the same name get two entries, and registering twice is one', () => {
    registerInstance(reg, a); registerInstance(reg, a); registerInstance(reg, b)
    expect(readdirSync(reg)).toHaveLength(2)
    expect(unregisterInstance(reg, a)).toBe(true)
    expect(unregisterInstance(reg, a)).toBe(false)
  })

  it('reads each registered instance from ITS current .env, and reports an install that is gone', () => {
    registerInstance(reg, a)
    writeFileSync(join(a, '.env'), 'MAIN_AGENT_ID=alpha\nWEB_PORT=4200\n')
    const gone = join(base, 'gone'); mkdirSync(gone); registerInstance(reg, gone); rmSync(gone, { recursive: true })
    const r = readRegistry(reg, '/home/u')
    expect(r.instances.map((i) => i.port)).toEqual([4200])
    expect(r.stale).toEqual([gone])
  })

  it('doctor exits 1 on a shared port and names it; the stale/unreadable files do not break it', () => {
    run(['register', a]); run(['register', b])
    writeFileSync(join(reg, 'broken.json'), '{ nope')
    const r = run(['doctor', a])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/ERROR port .*4100/)
  })

  it('doctor exits 0 when the instances are separate', () => {
    writeFileSync(join(b, '.env'), 'MAIN_AGENT_ID=beta\nWEB_PORT=4101\nTMUX_TMPDIR=' + join(b, 'tmux') + '\nMAIN_AGENT_ISOLATED_CONFIG=1\n')
    run(['register', a]); run(['register', b])
    const r = run(['doctor', a])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/OK: nothing is shared/)
  })

  it('info --json carries the description and no secret from the .env', () => {
    writeFileSync(join(a, '.env'), 'MAIN_AGENT_ID=alpha\nTELEGRAM_BOT_TOKEN=99:HUSH\n')
    const r = run(['info', a, '--json'])
    expect(JSON.parse(r.out).mainAgentId).toBe('alpha')
    expect(r.out).not.toContain('HUSH')
  })

  it('an unknown command or a missing root is a usage error', () => {
    expect(run(['wat', a]).code).toBe(2)
    expect(run(['doctor']).code).toBe(2)
    expect(existsSync(reg)).toBe(false)
  })
})

import { selfWarnings, nextFreePort, DEFAULT_NEW_INSTANCE_NAME } from '../instance.js'
import { readFileSync, statSync } from 'node:fs'

describe('names: nestor for a new instance, configurable per instance', () => {
  it('the name a new instance gets is nestor', () => {
    expect(DEFAULT_NEW_INSTANCE_NAME).toBe('nestor')
  })

  it('an install that names nothing is warned about, once per missing setting', () => {
    const w = selfWarnings(describeInstance('/srv/a', '', HOME))
    expect(w).toHaveLength(3)
    expect(w[0]).toMatch(/MAIN_AGENT_ID is not set/)
  })

  it('an install that states its names and port has nothing to be warned about', () => {
    expect(selfWarnings(describeInstance('/srv/a', 'MAIN_AGENT_ID=nestor\nSERVICE_ID=nestor\nWEB_PORT=3420\n', HOME))).toEqual([])
  })

  it('the main agent and the system can have different names', () => {
    const i = describeInstance('/srv/a', 'MAIN_AGENT_ID=ada\nSERVICE_ID=studio\nWEB_PORT=3420\n', HOME)
    expect(i.channelsSession).toBe('ada-channels')
    expect(i.units.dashboard).toBe('studio-dashboard')
  })

  it('nextFreePort skips the taken ones', () => {
    expect(nextFreePort([])).toBe(3420)
    expect(nextFreePort([3420, 3421, 3423])).toBe(3422)
  })

  describe('nestor init', () => {
    let base: string, reg: string, root: string
    beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'nestorinit-')); reg = join(base, 'reg'); root = join(base, 'inst'); mkdirSync(root) })
    afterEach(() => { rmSync(base, { recursive: true, force: true }) })
    const run = (args: string[]) => {
      const out: string[] = [], err: string[] = []
      const code = runInstanceCli(args, { NESTOR_REGISTRY_DIR: reg }, (s) => out.push(s), (s) => err.push(s), '/home/u')
      return { code, out: out.join('\n'), err: err.join('\n') }
    }

    it('names a fresh install nestor, with a port, in a file only the owner can read', () => {
      const r = run(['init', root])
      expect(r.code).toBe(0)
      const env = readFileSync(join(root, '.env'), 'utf-8')
      expect(env).toContain('MAIN_AGENT_ID=nestor')
      expect(env).toContain('SERVICE_ID=nestor')
      expect(env).toContain('WEB_PORT=3420')
      expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
      expect(selfWarnings(describeInstance(root, env, '/home/u'))).toEqual([])
    })

    it('takes the names and the port from the flags: the agent and the system are named separately', () => {
      run(['init', root, '--agent', 'ada', '--system', 'studio', '--port', '4000'])
      const i = describeInstance(root, readFileSync(join(root, '.env'), 'utf-8'), '/home/u')
      expect(i).toMatchObject({ mainAgentId: 'ada', unitId: 'studio', port: 4000 })
    })

    it('picks a port no registered instance uses', () => {
      const other = join(base, 'other'); mkdirSync(other); writeFileSync(join(other, '.env'), 'WEB_PORT=3420\n')
      run(['register', other])
      run(['init', root])
      expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('WEB_PORT=3421')
    })

    it('never changes a key that is set, keeps every other line, and says what it left', () => {
      writeFileSync(join(root, '.env'), '# mine\nTELEGRAM_BOT_TOKEN=keep:me\nMAIN_AGENT_ID=ada')
      const r = run(['init', root, '--agent', 'zed'])
      const env = readFileSync(join(root, '.env'), 'utf-8')
      expect(env).toContain('# mine\nTELEGRAM_BOT_TOKEN=keep:me\nMAIN_AGENT_ID=ada\n')
      expect(env).not.toContain('MAIN_AGENT_ID=zed')
      expect(env).toContain('SERVICE_ID=ada') // named after the main agent in force, not after the ignored --agent
      expect(r.out).toMatch(/already set, left as it was: MAIN_AGENT_ID=ada/)
    })

    it('does nothing when everything is already stated', () => {
      writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=a\nSERVICE_ID=a\nWEB_PORT=3999\n')
      expect(run(['init', root]).out).toMatch(/nothing to do/)
      expect(readFileSync(join(root, '.env'), 'utf-8')).toBe('MAIN_AGENT_ID=a\nSERVICE_ID=a\nWEB_PORT=3999\n')
    })

    describe('an install that has been running keeps what it uses today', () => {
      const markRunning = () => { mkdirSync(join(root, 'store')); writeFileSync(join(root, 'store', 'claudeclaw.db'), '') }

      it('is pinned to marveen and the default port, not renamed to nestor and not moved to another port', () => {
        markRunning()
        const other = join(base, 'other'); mkdirSync(other); writeFileSync(join(other, '.env'), 'WEB_PORT=3420\n')
        run(['register', other])
        const r = run(['init', root])
        const env = readFileSync(join(root, '.env'), 'utf-8')
        expect(env).toContain('MAIN_AGENT_ID=marveen')
        expect(env).toContain('SERVICE_ID=marveen')
        expect(env).toContain('WEB_PORT=3420') // it is on 3420 already; doctor, not init, says another instance shares it
        expect(env).not.toContain('nestor')
        expect(r.out).toMatch(/nothing is renamed or moved: main agent marveen, units marveen-\*, port 3420/)
      })

      it('the pinned names are the ones the app was already using', () => {
        markRunning()
        const before = describeInstance(root, '', '/home/u')
        run(['init', root])
        const after = describeInstance(root, readFileSync(join(root, '.env'), 'utf-8'), '/home/u')
        expect({ main: after.mainAgentId, unit: after.unitId, session: after.channelsSession, port: after.port, units: after.units })
          .toEqual({ main: before.mainAgentId, unit: before.unitId, session: before.channelsSession, port: before.port, units: before.units })
      })

      it('an install with only its isolated Claude config counts as running too', () => {
        mkdirSync(join(root, '.channels-config'))
        run(['init', root])
        expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('MAIN_AGENT_ID=marveen')
      })

      it('a rename is possible only when asked for, and says it is one', () => {
        markRunning()
        const r = run(['init', root, '--agent', 'nestor'])
        expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('MAIN_AGENT_ID=nestor')
        expect(r.out).toMatch(/WARNING: .*RENAME/)
      })

      it('--agent with the system name kept is a rename of the main agent only, and says so', () => {
        markRunning()
        const r = run(['init', root, '--agent', 'ada', '--system', 'marveen'])
        const env = readFileSync(join(root, '.env'), 'utf-8')
        expect(env).toContain('MAIN_AGENT_ID=ada')
        expect(env).toContain('SERVICE_ID=marveen')
        expect(r.out).toMatch(/WARNING: .*main agent marveen -> ada \(tmux session ada-channels\)/)
        expect(r.out).not.toMatch(/service units/)
      })

      it('--system alone on a running install is a rename of the units, and says so', () => {
        markRunning()
        const r = run(['init', root, '--system', 'studio'])
        expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('SERVICE_ID=studio')
        expect(r.out).toMatch(/WARNING: .*service units marveen-\* -> studio-\*/)
        expect(r.out).not.toMatch(/nothing is renamed or moved/)
      })

      it('--port alone on a running install is a move, and says so', () => {
        markRunning()
        const r = run(['init', root, '--port', '4000'])
        expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('WEB_PORT=4000')
        expect(r.out).toMatch(/WARNING: .*port 3420 -> 4000/)
      })

      it('a .env that names the main agent but not the system pins the system to that name, not to marveen', () => {
        markRunning()
        writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=foo\n')
        const before = describeInstance(root, 'MAIN_AGENT_ID=foo\n', '/home/u')
        const r = run(['init', root])
        const env = readFileSync(join(root, '.env'), 'utf-8')
        expect(env).toContain('SERVICE_ID=foo')
        expect(env).not.toContain('marveen')
        expect(describeInstance(root, env, '/home/u').units).toEqual(before.units)
        expect(r.out).toMatch(/nothing is renamed or moved: main agent foo/)
        expect(r.out).not.toMatch(/WARNING/)
      })

      it('a key that is already set is neither pinned over nor called a rename', () => {
        markRunning()
        writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=ada\n')
        const r = run(['init', root, '--agent', 'zed'])
        expect(readFileSync(join(root, '.env'), 'utf-8')).toContain('MAIN_AGENT_ID=ada')
        expect(r.out).not.toMatch(/WARNING/)
      })
    })

    it('refuses a bad name or port and writes nothing', () => {
      expect(run(['init', root, '--agent', 'bad name']).code).toBe(2)
      expect(run(['init', root, '--port', '99999']).code).toBe(2)
      expect(run(['init', root, '--system', 'x;rm']).code).toBe(2)
      expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('doctor prints the notes of an install that names nothing', () => {
      expect(run(['doctor', root]).out).toMatch(/NOTE\s+MAIN_AGENT_ID is not set/)
    })
  })
})
