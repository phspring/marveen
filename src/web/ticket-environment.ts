// The ticket environment of a card: what happens when a card of an isolating project goes in_progress, and what
// happens when it is finished (docs/jegy-kornyezet.md). It ties the pieces together: the project resolution, the
// dispatch decision, the workspace, the instance agent and the agent start.
//
//   prepare:  resolve the project -> decide (shared / existing / new / stacked / queued) -> create the workspace ->
//             create the instance agent -> start it. A step that fails undoes the steps before it, so a card never
//             ends up with a half-built environment.
//   release:  stop the instance -> archive its memory into the template -> delete it -> remove the workspace, unless
//             the workspace holds work nobody has seen (uncommitted, or commits no remote has), which is KEPT and
//             reported.
//
// Everything that touches the running system (starting and stopping a session, writing a card comment, reading the
// other cards' scopes) comes in through `deps`, so the whole flow runs in tests without a session. Nothing here
// calls the kanban routes yet: that is the next step, behind a switch that is off by default.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolatesTickets, resolveProject, type ProjectConfig, type ProjectRegistry } from '../projects.js'
import { decideWorkspace, type ActiveTicket } from '../workspace-decision.js'
import { parseScopeText } from '../kanban-ticket-fields.js'
import {
  createWorkspace, removeWorkspace, planWorkspace, listWorkspaces, ticketSlug, type GitRunner, type WorkspaceMarker, type WorkspacePlan,
} from './workspace.js'
import {
  createAgentInstance, removeAgentInstance, archiveInstanceMemory, listAgentInstances, instanceName,
} from './agent-instance.js'

/** The card fields the environment reads. */
export interface TicketCard {
  id: string
  project: string | null
  external_ref: string | null
  scope: string | null
}

export interface EnvironmentDeps {
  registry: ProjectRegistry
  /** The agents directory (AGENTS_BASE_DIR). */
  agentsBase: string
  /** Ids that can never be a template (the main agent, the reserved system ids). */
  reservedIds: readonly string[]
  git?: GitRunner
  /** The scope text of the card that owns `ticket` in `project`, or null (not declared, or no such card). */
  scopeOfTicket: (ticket: string, project: string) => string | null
  startAgent: (name: string) => Promise<{ ok: boolean; error?: string }>
  stopAgent: (name: string) => Promise<{ ok: boolean; error?: string }>
  isRunning: (name: string) => boolean
  /** A comment on the card, written by the system. Failures must not throw. */
  comment: (cardId: string, text: string) => void
}

export type PrepareResult =
  /** Not an isolating project, no project, or a template that cannot have instances: today's path. */
  | { kind: 'shared' }
  | { kind: 'ready'; instance: string; workspace: string; branch: string; baseBranch: string; project: string; created: boolean }
  | { kind: 'queued'; reason: 'capacity' | 'overlap' | 'stacking-unsupported'; waitingFor: string[]; project: string }
  | { kind: 'failed'; error: string }

export type ReleaseResult =
  /**
   * released: something was taken down in this call (an instance, or the workspace). keptWorkspace: the workspace is
   * still there because it holds work no remote has seen. keptNew: this call is the first to find it so (the card has
   * been told); the same workspace on the next pass is kept again without a new comment and without being reported.
   */
  | { ok: true; released: boolean; keptWorkspace: string | null; keptNew: boolean }
  | { ok: false; error: string }

/** The ticket key of a card: its external reference when it has a usable one, otherwise its card id. */
export function ticketKeyOf(card: TicketCard): string | null {
  return ticketSlug(card.external_ref) ?? ticketSlug(card.id)
}

function projectOf(card: TicketCard, registry: ProjectRegistry): ProjectConfig | null {
  const r = resolveProject({ project: card.project, externalRef: card.external_ref }, registry)
  return r && isolatesTickets(r.project) ? r.project : null
}

function activeTickets(project: ProjectConfig, deps: EnvironmentDeps): ActiveTicket[] {
  return listWorkspaces(project).map((m) => ({
    ticket: m.ticket,
    scope: parseScopeText(deps.scopeOfTicket(m.ticket, project.name)),
    branch: m.branch,
    baseBranch: m.baseBranch,
    createdAt: m.createdAt,
  }))
}

/** The plan of an existing workspace, rebuilt from its marker (a stacked one keeps the branch it was cut from). */
function planFromMarker(project: ProjectConfig, m: WorkspaceMarker): WorkspacePlan | null {
  const stackOn = m.baseBranch !== project.baseBranch ? { stackOn: { branch: m.baseBranch } } : {}
  const r = planWorkspace(project, m.ticket, { branch: m.branch, ...stackOn })
  return r.ok ? r.plan : null
}

/** Undo what a failed prepare made: the instance first (its session), then the workspace. Best effort. */
async function rollback(plan: WorkspacePlan | null, instance: string | null, deps: EnvironmentDeps): Promise<void> {
  if (instance) {
    try { if (deps.isRunning(instance)) await deps.stopAgent(instance) } catch { /* best effort */ }
    try { removeAgentInstance(deps.agentsBase, instance, { isRunning: deps.isRunning }) } catch { /* best effort */ }
  }
  if (plan) {
    try { await removeWorkspace(plan, { force: true }, deps.git) } catch { /* best effort */ }
  }
}

/**
 * Make the environment of a card ready, for the agent `template` it is assigned to.
 * Idempotent: a card that already has its workspace and instance gets them back (and the instance started again
 * when its session is down).
 */
export async function prepareTicketEnvironment(card: TicketCard, template: string, deps: EnvironmentDeps): Promise<PrepareResult> {
  const project = projectOf(card, deps.registry)
  if (!project) return { kind: 'shared' }
  if (deps.reservedIds.includes(template)) return { kind: 'shared' }
  const ticket = ticketKeyOf(card)
  if (!ticket) return { kind: 'failed', error: 'the card has no usable ticket key (its external_ref and its id are both unusable as a name)' }

  const decision = decideWorkspace({ project, ticket, scope: parseScopeText(card.scope), active: activeTickets(project, deps) })
  if (decision.action === 'shared') return { kind: 'shared' }
  if (decision.action === 'queued') return { kind: 'queued', reason: decision.reason, waitingFor: decision.waitingFor, project: project.name }

  // the plan: the existing workspace's own, a stacked one, or a fresh one off the base branch
  let plan: WorkspacePlan | null
  if (decision.action === 'existing') {
    const marker = listWorkspaces(project).find((m) => m.ticket === ticket)
    plan = marker ? planFromMarker(project, marker) : null
    if (!plan) return { kind: 'failed', error: 'the ticket holds a workspace whose record cannot be read back' }
  } else if (decision.action === 'stacked') {
    const r = planWorkspace(project, ticket, { stackOn: { branch: decision.baseBranch } })
    if (!r.ok) return { kind: 'queued', reason: 'stacking-unsupported', waitingFor: [decision.onTicket], project: project.name }
    plan = r.plan
  } else {
    const r = planWorkspace(project, ticket)
    if (!r.ok) return { kind: 'failed', error: r.error }
    plan = r.plan
  }

  const ws = await createWorkspace(plan, deps.git)
  if (!ws.ok) return { kind: 'failed', error: `workspace: ${ws.error}` }
  const wsCreated = ws.created

  const inst = createAgentInstance(deps.agentsBase, template, ticket, {
    project: project.name, workspace: plan.path, reservedIds: deps.reservedIds,
  })
  if (!inst.ok) {
    if (wsCreated) await rollback(plan, null, deps)
    return { kind: 'failed', error: `instance: ${inst.error}` }
  }

  if (!deps.isRunning(inst.name)) {
    const started = await deps.startAgent(inst.name)
    if (!started.ok) {
      // undo only what this call made: an existing workspace or instance stays for the next attempt
      await rollback(wsCreated ? plan : null, inst.created ? inst.name : null, deps)
      return { kind: 'failed', error: `start: ${started.error ?? 'the instance did not start'}` }
    }
  }

  if (wsCreated || inst.created) {
    deps.comment(card.id, `Jegy-környezet kész. Példány: ${inst.name}, workspace: ${plan.path}, ág: ${plan.branch} (alap: ${plan.baseBranch}).`)
  }
  return {
    kind: 'ready', instance: inst.name, workspace: plan.path, branch: plan.branch, baseBranch: plan.baseBranch,
    project: project.name, created: wsCreated || inst.created,
  }
}

/** The workspaces the card has already been told were kept, by card and path; forgotten once the workspace is gone. */
const keptNotified = new Set<string>()

/**
 * Tear the environment of a card down. The instance goes (its memory is archived into the template first). The
 * workspace goes too, unless it holds work no remote has seen: then it is kept and reported, never forced.
 */
export async function releaseTicketEnvironment(card: TicketCard, deps: EnvironmentDeps): Promise<ReleaseResult> {
  const project = projectOf(card, deps.registry)
  if (!project) return { ok: true, released: false, keptWorkspace: null, keptNew: false }
  const ticket = ticketKeyOf(card)
  if (!ticket) return { ok: true, released: false, keptWorkspace: null, keptNew: false }

  const instances = listAgentInstances(deps.agentsBase).filter((i) => i.of.ticket === ticket && i.of.project === project.name)
  const marker = listWorkspaces(project).find((m) => m.ticket === ticket)
  if (instances.length === 0 && !marker) return { ok: true, released: false, keptWorkspace: null, keptNew: false }

  for (const i of instances) {
    if (deps.isRunning(i.name)) {
      const stopped = await deps.stopAgent(i.name)
      if (!stopped.ok) return { ok: false, error: `could not stop ${i.name}: ${stopped.error ?? 'unknown error'}; nothing was removed` }
    }
    const archived = archiveInstanceMemory(deps.agentsBase, i.name)
    // A memory that could not be archived must not be deleted with the instance: keep the instance and say so.
    if (!archived.ok) return { ok: false, error: `the memory of ${i.name} could not be archived (${archived.error}); the instance was kept` }
    const removed = removeAgentInstance(deps.agentsBase, i.name, { isRunning: deps.isRunning })
    if (!removed.ok) return { ok: false, error: removed.error }
  }

  let kept: string | null = null
  let keptNew = false
  let workspaceRemoved = false
  if (marker) {
    const plan = planFromMarker(project, marker)
    if (!plan) return { ok: false, error: 'the workspace record cannot be read back, the workspace was kept' }
    const r = await removeWorkspace(plan, {}, deps.git)
    const notice = `${card.id}\0${plan.path}`
    if (!r.ok) {
      kept = plan.path
      // Every reconcile pass lands here again for a workspace that stays (a minute apart): the card is told the first
      // time only, or a workspace kept for a day would collect a thousand identical comments.
      if (!keptNotified.has(notice)) {
        keptNotified.add(notice)
        keptNew = true
        deps.comment(card.id, `A workspace-et nem töröltem, mert nem mentett munka van benne (nem commitolt változás vagy olyan commit, amit még nem látott távoli ág): ${plan.path}. ${r.error}`)
      }
    } else {
      workspaceRemoved = true
      keptNotified.delete(notice)
    }
  }
  return { ok: true, released: instances.length > 0 || workspaceRemoved, keptWorkspace: kept, keptNew }
}

/** Is there an environment for this card right now (an instance or a workspace)? */
export function hasTicketEnvironment(card: TicketCard, deps: Pick<EnvironmentDeps, 'registry' | 'agentsBase'>): boolean {
  const project = projectOf(card, deps.registry)
  const ticket = ticketKeyOf(card)
  if (!project || !ticket) return false
  if (listWorkspaces(project).some((m) => m.ticket === ticket)) return true
  return listAgentInstances(deps.agentsBase).some((i) => i.of.ticket === ticket && i.of.project === project.name)
}

/** A card's instance name for a template, when the environment exists on disk. */
export function instanceNameFor(card: TicketCard, template: string, deps: Pick<EnvironmentDeps, 'agentsBase'>): string | null {
  const ticket = ticketKeyOf(card)
  const name = ticket ? instanceName(template, ticket) : null
  return name && existsSync(join(deps.agentsBase, name, 'agent-config.json')) ? name : null
}
