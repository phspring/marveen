// `nestor info | doctor | register | unregister` (bin/nestor calls this with the install root).
//   info        what this instance owns (port, units, tmux, Claude config, token path, database path)
//   doctor      compare it with every other registered instance; exit 1 when two cannot run side by side
//   register    add this install to the machine's list; unregister removes it
// `--json` prints machine-readable output. Nothing here changes a running system.

import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { assertEnvEntry } from './env.js'
import { parseEnvContent } from './env-parse.js'
import { conflictsWithOthers, DEFAULT_NEW_INSTANCE_NAME, LEGACY_FALLBACK_NAME, nextFreePort, selfWarnings, type Conflict, type InstanceInfo } from './instance.js'
import { describeInstallAt, readRegistry, registerInstance, registryDir, unregisterInstance } from './instance-registry.js'

export function renderInfo(i: InstanceInfo): string {
  return [
    `instance        ${i.unitId}`,
    `install         ${i.root}`,
    `main agent      ${i.mainAgentId}  (tmux session ${i.channelsSession})`,
    `dashboard       http://${i.host}:${i.port}`,
    `service units   ${i.units.dashboard}, ${i.units.channels}`,
    `tmux server     ${i.tmuxServer === 'default' ? "default (the machine's one server)" : i.tmuxServer}`,
    `Claude config   ${i.claudeConfig}${i.ownClaudeConfig ? '' : '  (shared)'}`,
    `token           ${i.tokenPath}`,
    `database        ${i.dbPath}`,
    `node            ${i.node ?? 'from PATH'}`,
  ].join('\n')
}

export function renderDoctor(self: InstanceInfo, others: readonly InstanceInfo[], conflicts: readonly Conflict[], stale: readonly string[]): string {
  const lines = [`${self.unitId} (${self.root}): ${others.length} other registered instance(s) on this machine`]
  for (const w of selfWarnings(self)) lines.push(`NOTE  ${w}`)
  for (const o of others) lines.push(`  - ${o.unitId}  ${o.root}  port ${o.port}`)
  for (const s of stale) lines.push(`  (registered but gone, ignored: ${s})`)
  if (conflicts.length === 0) {
    lines.push('', 'OK: nothing is shared with another registered instance.')
  } else {
    lines.push('')
    for (const c of conflicts) lines.push(`${c.level === 'error' ? 'ERROR' : 'WARN '} ${c.what} (${c.between[0]} / ${c.between[1]}): ${c.detail}`)
  }
  return lines.join('\n')
}

/** Returns the exit code. `out`/`err` are the writers, so the command is testable. */
export function runInstanceCli(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void, home = homedir()): number {
  const [cmd, root, ...rest] = argv
  if (!cmd || !root) { err('usage: instance-cli <info|doctor|init|register|unregister> <install-root> [--json]'); return 2 }
  const json = rest.includes('--json')
  const self = describeInstallAt(root, home)
  const dir = registryDir(env, home)

  if (cmd === 'info') { out(json ? JSON.stringify(self, null, 2) : renderInfo(self)); return 0 }
  if (cmd === 'init') return initInstance(self.root, rest, readRegistry(dir, home).instances, out, err)
  if (cmd === 'register') { registerInstance(dir, self.root); out(`registered ${self.unitId} (${self.root}) in ${dir}`); return 0 }
  if (cmd === 'unregister') { out(unregisterInstance(dir, self.root) ? `unregistered ${self.root}` : `${self.root} was not registered`); return 0 }
  if (cmd === 'doctor') {
    const reg = readRegistry(dir, home)
    const others = reg.instances.filter((o) => o.root !== self.root)
    const conflicts = conflictsWithOthers(self, others)
    out(json ? JSON.stringify({ self, others, conflicts, stale: reg.stale }, null, 2) : renderDoctor(self, others, conflicts, reg.stale))
    return conflicts.some((c) => c.level === 'error') ? 1 : 0
  }
  err(`unknown command: ${cmd}`)
  return 2
}

/** `--agent <name> --system <name> --port <n>`: flag values, in order of appearance. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * An install that has been running: its database or its isolated Claude config exists. Its names and port are
 * whatever the app has been using, even where the .env says nothing (the app falls back to marveen / 3420).
 */
export function isExistingInstall(root: string): boolean {
  return existsSync(join(root, 'store', 'claudeclaw.db')) || existsSync(join(root, '.channels-config'))
}

/**
 * Write an install's own names and port into its .env, only for the keys it does not already state.
 *  - a NEW install (never run): `nestor` for the main agent, the system named after it, the first port no
 *    registered instance uses;
 *  - an EXISTING install: what it uses today (the app's fallback name, the default port), so the .env says
 *    out loud what the app was already doing and nothing is renamed or moved. A different name or port is asked
 *    for with --agent / --system / --port, and is then a rename, which changes the tmux session and the unit names.
 * An existing value in the .env is never changed.
 */
export function initInstance(root: string, args: string[], registered: readonly InstanceInfo[], out: (s: string) => void, err: (s: string) => void): number {
  const idRx = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  const existing = isExistingInstall(root)
  const agentArg = flag(args, '--agent')
  const systemArg = flag(args, '--system')
  const portArg = flag(args, '--port')
  const agent = agentArg ?? (existing ? LEGACY_FALLBACK_NAME : DEFAULT_NEW_INSTANCE_NAME)
  const system = systemArg ?? agent
  if (!idRx.test(agent) || !idRx.test(system)) { err('init: --agent and --system must be letters, digits, dot, dash or underscore (at most 64)'); return 2 }
  if (portArg !== undefined && !(/^\d{1,5}$/.test(portArg) && +portArg > 0 && +portArg < 65536)) { err('init: --port must be a number from 1 to 65535'); return 2 }

  const envPath = join(root, '.env')
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
  const have = parseEnvContent(text, ['MAIN_AGENT_ID', 'SERVICE_ID', 'WEB_PORT'])
  // an existing install is already on a port, the default one unless its .env says otherwise
  const port = portArg ?? (existing ? '3420' : String(nextFreePort(registered.map((i) => i.port))))
  const wanted: Array<[string, string]> = [['MAIN_AGENT_ID', agent], ['SERVICE_ID', system], ['WEB_PORT', port]]
  const added = wanted.filter(([k]) => !(k in have))
  for (const [k, v] of added) assertEnvEntry(k, v)
  if (added.length === 0) { out('nothing to do: MAIN_AGENT_ID, SERVICE_ID and WEB_PORT are already set in .env'); return 0 }
  mkdirSync(root, { recursive: true })
  const body = (text === '' || text.endsWith('\n') ? text : text + '\n') + added.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(envPath, body, { mode: 0o600 })
  if (text === '') chmodSync(envPath, 0o600)
  out(`wrote to ${envPath}: ${added.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  const kept = wanted.filter(([k]) => k in have).map(([k]) => `${k}=${have[k]}`)
  if (kept.length) out(`already set, left as it was: ${kept.join(', ')}`)
  if (existing && agentArg === undefined) {
    out(`this install has been running, so it keeps its current names (${LEGACY_FALLBACK_NAME}): nothing is renamed. To rename it, pass --agent and --system (that changes the tmux session and the unit names: stop its services first).`)
  } else if (existing && agent !== LEGACY_FALLBACK_NAME && !('MAIN_AGENT_ID' in have)) {
    out(`WARNING: this install has been running under the name ${LEGACY_FALLBACK_NAME}; ${agent} is a RENAME (new tmux session and unit names). Stop its services first and re-install them.`)
  }
  out('next: nestor register, then nestor doctor')
  return 0
}

// Run only when started as a program, not when imported by a test.
if (process.argv[1] && /instance-cli\.(js|ts)$/.test(process.argv[1])) {
  process.exit(runInstanceCli(process.argv.slice(2), process.env, (s) => console.log(s), (s) => console.error(s)))
}
