// bin/nestor: the launcher of ONE install. The point of these tests is what it refuses: it acts only on the install
// it sits in. systemctl is a fake that logs its calls, so no real service is touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'nestor')

let base: string, root: string, fakeBin: string, log: string
const children: ChildProcess[] = []

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
# args: --user <verb> ...
shift
case "$1" in
  show-environment) exit 0 ;;
  cat) n="\${2%.service}"; grep -q "^$n|" "$FAKE_UNITS" && exit 0 || exit 1 ;;
  show) n="\${2%.service}"; grep "^$n|" "$FAKE_UNITS" | head -1 | cut -d'|' -f2; exit 0 ;;
  is-active) echo active; exit 0 ;;
  *) echo "$@" >> "$FAKE_LOG"; exit 0 ;;
esac
`

function nestor(args: string[], units: string[] = [], extraEnv: Record<string, string> = {}) {
  writeFileSync(join(base, 'units'), units.join('\n') + (units.length ? '\n' : ''))
  const r = spawnSync('bash', [join(root, 'bin', 'nestor'), ...args], {
    encoding: 'utf-8',
    env: {
      PATH: `${fakeBin}:/usr/bin:/bin`, HOME: base, XDG_CONFIG_HOME: join(base, 'xdg'),
      NESTOR_NODE: process.execPath, FAKE_UNITS: join(base, 'units'), FAKE_LOG: log, ...extraEnv,
    },
  })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf-8') : '')

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'nestorlaunch-')))
  root = join(base, 'install'); fakeBin = join(base, 'fakebin'); log = join(base, 'calls.log')
  mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'dist')); mkdirSync(join(root, 'store')); mkdirSync(fakeBin)
  copyFileSync(LAUNCHER, join(root, 'bin', 'nestor')); chmodSync(join(root, 'bin', 'nestor'), 0o755)
  writeFileSync(join(fakeBin, 'systemctl'), FAKE_SYSTEMCTL); chmodSync(join(fakeBin, 'systemctl'), 0o755)
  // a dummy dashboard: records its pid where the real one does, then waits
  writeFileSync(join(root, 'dist', 'index.js'), "require('fs').writeFileSync('store/claudeclaw.pid', String(process.pid)); setInterval(() => {}, 1000)\n")
})
afterEach(async () => {
  for (const c of children) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  children.length = 0
  const p = join(root, 'store', 'claudeclaw.pid')
  if (existsSync(p)) { try { process.kill(+readFileSync(p, 'utf-8'), 'SIGKILL') } catch { /* gone */ } }
  rmSync(base, { recursive: true, force: true })
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('units of another install are never touched', () => {
  it('an install that names nothing falls back to the default unit name, and refuses a unit that runs from elsewhere', () => {
    const r = nestor(['start', 'dashboard'], ['nestor-dashboard|/var/www/nestor-other'])
    expect(r.code).toBe(3)
    expect(r.err).toMatch(/belongs to another install \(\/var\/www\/nestor-other\)/)
    expect(calls()).toBe('')
  })

  it('stop and restart are refused the same way, and the pid-file path is not used as a way around it', () => {
    for (const verb of ['stop', 'restart']) {
      const r = nestor([verb], ['nestor-dashboard|/var/www/nestor-other', 'nestor-channels|/var/www/nestor-other'])
      expect(r.code).toBe(3)
    }
    expect(calls()).toBe('')
    expect(existsSync(join(root, 'store', 'dashboard.log'))).toBe(false)
  })

  it('acts on its own unit only', () => {
    writeFileSync(join(root, '.env'), 'SERVICE_ID=studio\nMAIN_AGENT_ID=ada\n')
    const r = nestor(['restart', 'dashboard'], [`studio-dashboard|${root}`, 'nestor-dashboard|/var/www/nestor-other'])
    expect(r.code).toBe(0)
    expect(calls().trim()).toBe('restart studio-dashboard')
  })

  it('status says a unit is not ours instead of reporting it as this install\'s', () => {
    const r = nestor(['status'], ['nestor-dashboard|/var/www/nestor-other'])
    expect(r.out).toMatch(/nestor-dashboard\s+NOT OURS/)
  })
})

describe('the pid file is trusted only for this install\'s own dashboard', () => {
  // "alive" is the child's own exit state, after the event loop has had a turn: a killed child that has not been
  // reaped yet still answers kill(pid, 0)
  const stillRunning = async (c: ChildProcess) => { await sleepMs(250); return c.exitCode === null && c.signalCode === null }

  it('a process in another directory is not stopped, even when it looks like the dashboard and the pid file names it', async () => {
    const other = join(base, 'elsewhere'); mkdirSync(other)
    // its command line contains dist/index.js, so only the working directory tells it apart from this install's
    const lookalike = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'dist/index.js'], { cwd: other, stdio: 'ignore' }); children.push(lookalike)
    await sleepMs(100)
    writeFileSync(join(root, 'store', 'claudeclaw.pid'), String(lookalike.pid))
    const r = nestor(['stop'])
    expect(r.out).toMatch(/not ours/)
    expect(await stillRunning(lookalike)).toBe(true)
  })

  it('a process in this directory that is not running dist/index.js is not stopped either', async () => {
    const sleeper = spawn('sleep', ['30'], { cwd: root, stdio: 'ignore' }); children.push(sleeper)
    await sleepMs(100)
    writeFileSync(join(root, 'store', 'claudeclaw.pid'), String(sleeper.pid))
    const r = nestor(['stop'])
    expect(r.out).toMatch(/not ours/)
    expect(await stillRunning(sleeper)).toBe(true)
  })

  it('start runs this install\'s dashboard, a second start does not start another, stop ends it', async () => {
    const a = nestor(['start'])
    expect(a.out).toMatch(/dashboard started/)
    await sleepMs(500)
    const pid = +readFileSync(join(root, 'store', 'claudeclaw.pid'), 'utf-8')
    expect(alive(pid)).toBe(true)
    expect(nestor(['start']).out).toMatch(new RegExp(`already running \\(pid ${pid}\\)`))
    expect(nestor(['stop']).out).toMatch(new RegExp(`stopped dashboard \\(pid ${pid}\\)`))
    await sleepMs(300)
    expect(alive(pid)).toBe(false)
  })
})

describe('tmux of its own', () => {
  it('the pid-file start hands the dashboard the TMUX_TMPDIR the .env names, and makes the directory', async () => {
    const tmuxDir = join(base, 'tmux-dir')
    writeFileSync(join(root, '.env'), `TMUX_TMPDIR=${tmuxDir}\n`)
    writeFileSync(join(root, 'dist', 'index.js'), "require('fs').writeFileSync('store/claudeclaw.pid', String(process.pid)); require('fs').writeFileSync('store/seen-tmux', process.env.TMUX_TMPDIR || '(unset)'); setInterval(() => {}, 1000)\n")
    nestor(['start'])
    await sleepMs(500)
    expect(readFileSync(join(root, 'store', 'seen-tmux'), 'utf-8')).toBe(tmuxDir)
    expect(existsSync(tmuxDir)).toBe(true)
  })

  it('without a TMUX_TMPDIR in the .env the dashboard inherits nothing of the caller\'s', async () => {
    writeFileSync(join(root, 'dist', 'index.js'), "require('fs').writeFileSync('store/claudeclaw.pid', String(process.pid)); require('fs').writeFileSync('store/seen-tmux', process.env.TMUX_TMPDIR || '(unset)'); setInterval(() => {}, 1000)\n")
    nestor(['start'])
    await sleepMs(500)
    expect(readFileSync(join(root, 'store', 'seen-tmux'), 'utf-8')).toBe('(unset)')
  })
})

describe('status', () => {
  it('does not report another process on the port as this install answering', async () => {
    // the answering server is a separate process: spawnSync below blocks this one's event loop
    const srv = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('hi')).listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(srv)
    const port = await new Promise<number>((res) => srv.stdout!.once('data', (d) => res(+String(d).trim())))
    writeFileSync(join(root, '.env'), `WEB_PORT=${port}\n`)
    const r = nestor(['status'])
    expect(r.out).toMatch(/answers \(200\), but NOT from this install/)
  })
})

describe('guards', () => {
  it('refuses a Node older than 22', () => {
    const old = join(base, 'old-node'); writeFileSync(old, '#!/bin/sh\necho 18\n'); chmodSync(old, 0o755)
    const r = nestor(['node', '-v'], [], { NESTOR_NODE: old })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/Node 18, this install needs 22/)
  })

  it('help needs no Node at all', () => {
    const r = nestor(['help'], [], { NESTOR_NODE: '/nonexistent/node', PATH: '/usr/bin:/bin' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/launcher of ONE install/)
  })

  it('an unknown command is a usage error', () => {
    expect(nestor(['wat']).code).toBe(2)
  })

  it('info says to build first when dist/instance-cli.js is missing', () => {
    expect(nestor(['info']).err).toMatch(/dist\/instance-cli\.js is missing/)
  })
})

describe('install-service', () => {
  const unitFile = (name: string) => join(base, 'xdg', 'systemd', 'user', `${name}.service`)

  it('writes this install\'s unit, named after its SERVICE_ID, and reloads', () => {
    writeFileSync(join(root, '.env'), 'SERVICE_ID=studio\nTMUX_TMPDIR=/data/tmux\n')
    const r = nestor(['install-service'])
    expect(r.code).toBe(0)
    const unit = readFileSync(unitFile('studio-dashboard'), 'utf-8')
    expect(unit).toContain(`WorkingDirectory=${root}`)
    expect(unit).toContain(`ExecStart=${process.execPath} ${root}/dist/index.js`)
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain('Environment=TMUX_TMPDIR=/data/tmux')
    expect(calls()).toContain('daemon-reload')
  })

  it('never overwrites the unit file of another install, not even with --force', () => {
    writeFileSync(join(root, '.env'), 'SERVICE_ID=studio\n')
    mkdirSync(dirname(unitFile('x')), { recursive: true })
    const theirs = '[Service]\nWorkingDirectory=/somewhere/else\n'
    writeFileSync(unitFile('studio-dashboard'), theirs)
    const r = nestor(['install-service', '--force'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/belongs to another install/)
    expect(readFileSync(unitFile('studio-dashboard'), 'utf-8')).toBe(theirs)
  })

  it('a changed own unit needs --force', () => {
    writeFileSync(join(root, '.env'), 'SERVICE_ID=studio\n')
    nestor(['install-service'])
    const file = unitFile('studio-dashboard')
    writeFileSync(file, readFileSync(file, 'utf-8').replace('RestartSec=5', 'RestartSec=99'))
    expect(nestor(['install-service']).code).toBe(1)
    expect(nestor(['install-service', '--force']).code).toBe(0)
    expect(readFileSync(file, 'utf-8')).toContain('RestartSec=5')
  })
})
