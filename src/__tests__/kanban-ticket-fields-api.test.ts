// The card's ticket-environment fields (external_ref, scope) through the database and the HTTP boundary:
// stored in the clean shape, validated loudly, covered by the row version, and safe in the dashboard's whole-card
// round trip. docs/jegy-kornyezet.md.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import Database from 'better-sqlite3'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: vi.fn() }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import { initDatabase, getDb, createKanbanCard, getKanbanCard, updateKanbanCard, KANBAN_WRITABLE_FIELDS, KANBAN_CREATE_FIELDS } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 200
  let sent = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((chunk?: unknown) => { if (chunk != null) sent += String(chunk) }),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path, method, url: new URL(`http://localhost${path}`),
  } as never)
  expect(handled).toBe(true)
  return { status, body: sent ? JSON.parse(sent) as Record<string, unknown> : {} }
}
const post = (fields: Record<string, unknown>) => call('POST', '/api/kanban', fields)
const put = (id: string, fields: Record<string, unknown>) => call('PUT', `/api/kanban/${id}`, fields)

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
})

describe('the field lists', () => {
  it('both new fields are creatable and writable, so the version trigger and the whole-card PUT cover them', () => {
    for (const f of ['external_ref', 'scope']) {
      expect(KANBAN_WRITABLE_FIELDS as readonly string[]).toContain(f)
      expect(KANBAN_CREATE_FIELDS as readonly string[]).toContain(f)
    }
  })
})

describe('database layer', () => {
  it('a new card has both fields null, and createKanbanCard stores what it is given', () => {
    createKanbanCard({ id: 'a1', title: 'plain' })
    expect(getKanbanCard('a1')).toMatchObject({ external_ref: null, scope: null })
    createKanbanCard({ id: 'a2', title: 'ticket', external_ref: 'TVR-2658', scope: 'src/games\nsrc/menu' })
    expect(getKanbanCard('a2')).toMatchObject({ external_ref: 'TVR-2658', scope: 'src/games\nsrc/menu' })
  })

  it('a real change moves the version, an unchanged write does not', () => {
    createKanbanCard({ id: 'v1', title: 'Card' })
    updateKanbanCard('v1', { external_ref: 'TVR-1' })
    expect(getKanbanCard('v1')?.version).toBe(1)
    updateKanbanCard('v1', { external_ref: 'TVR-1' })
    expect(getKanbanCard('v1')?.version).toBe(1)
    updateKanbanCard('v1', { scope: 'src' })
    expect(getKanbanCard('v1')?.version).toBe(2)
  })

  it('a script writing the table directly moves the version too (the trigger covers the new columns)', () => {
    createKanbanCard({ id: 'v2', title: 'Card' })
    getDb().prepare('UPDATE kanban_cards SET scope = ? WHERE id = ?').run('docs', 'v2')
    expect(getKanbanCard('v2')?.version).toBe(1)
    getDb().prepare('UPDATE kanban_cards SET external_ref = ? WHERE id = ?').run('TVR-9', 'v2')
    expect(getKanbanCard('v2')?.version).toBe(2)
  })
})

describe('POST /api/kanban', () => {
  it('stores a clean reference and a scope given as a list', async () => {
    const r = await post({ id: 'p1', title: 'T', external_ref: '  TVR-2658 ', scope: ['src/games/', './src/menu', 'src/games'] })
    expect(r.status).toBe(200)
    expect(getKanbanCard('p1')).toMatchObject({ external_ref: 'TVR-2658', scope: 'src/games\nsrc/menu' })
  })

  it('refuses a bad reference or scope with a 400 and creates nothing', async () => {
    for (const bad of [{ external_ref: '../x' }, { external_ref: 'a b' }, { scope: ['/etc'] }, { scope: ['a/../b'] }, { scope: 3 }]) {
      const id = `bad-${Math.random().toString(36).slice(2, 8)}`
      const r = await post({ id, title: 'T', ...bad })
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(getKanbanCard(id)).toBeUndefined()
    }
  })

  it('without the fields the card is created as before', async () => {
    expect((await post({ id: 'p2', title: 'T' })).status).toBe(200)
    expect(getKanbanCard('p2')).toMatchObject({ external_ref: null, scope: null })
  })
})

describe('PUT /api/kanban/:id', () => {
  it('sets, changes and clears the fields', async () => {
    createKanbanCard({ id: 'u1', title: 'T' })
    expect((await put('u1', { external_ref: 'TVR-1', scope: ['src'] })).status).toBe(200)
    expect(getKanbanCard('u1')).toMatchObject({ external_ref: 'TVR-1', scope: 'src' })
    expect((await put('u1', { scope: ['src/a', 'src/b'] })).status).toBe(200)
    expect(getKanbanCard('u1')?.scope).toBe('src/a\nsrc/b')
    expect((await put('u1', { external_ref: null, scope: null })).status).toBe(200)
    expect(getKanbanCard('u1')).toMatchObject({ external_ref: null, scope: null })
  })

  it('a bad value is a 400 that names the problem, and the card is left untouched', async () => {
    createKanbanCard({ id: 'u2', title: 'T', external_ref: 'TVR-2', scope: 'src' })
    const before = getKanbanCard('u2')
    const r1 = await put('u2', { external_ref: '../escape' })
    expect(r1.status).toBe(400)
    expect(String(r1.body.error)).toContain('external_ref')
    const r2 = await put('u2', { scope: ['ok', '/abs'] })
    expect(r2.status).toBe(400)
    expect(String(r2.body.error)).toContain('scope')
    expect(getKanbanCard('u2')).toEqual(before)
  })

  it('the dashboard round trip (the whole card sent back, scope as the stored text) is accepted and changes nothing', async () => {
    createKanbanCard({ id: 'u3', title: 'T', external_ref: 'TVR-3', scope: 'src/a\nsrc/b' })
    const card = getKanbanCard('u3')!
    const r = await put('u3', { ...card })
    expect(r.status).toBe(200)
    const after = getKanbanCard('u3')!
    expect(after.scope).toBe('src/a\nsrc/b')
    expect(after.external_ref).toBe('TVR-3')
    expect(after.version).toBe(card.version)
  })

  it('a stale whole-card PUT cannot overwrite a scope that changed in the meantime', async () => {
    createKanbanCard({ id: 'u4', title: 'T', scope: 'src/a' })
    const stale = getKanbanCard('u4')!
    updateKanbanCard('u4', { scope: 'src/a\nsrc/b' })
    const r = await put('u4', { ...stale, version: stale.version })
    expect(r.status).toBe(409)
    expect(getKanbanCard('u4')?.scope).toBe('src/a\nsrc/b')
  })
})

describe('the migration on an existing database', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kanban-ticket-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } })

  it('adds both columns to a database that has none, keeps its cards, and is idempotent', () => {
    const file = join(dir, 'old.db')
    // an install from before the two columns: the kanban table exactly as an older build left it
    const old = new Database(file)
    old.exec(`
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
        assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, parent_id TEXT, dispatched_at INTEGER
      );
      INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('old1', 'Existing card', 1, 1);
    `)
    old.close()

    initDatabase(file)
    expect(getKanbanCard('old1')).toMatchObject({ title: 'Existing card', external_ref: null, scope: null })
    updateKanbanCard('old1', { external_ref: 'TVR-7', scope: 'src' })
    expect(getKanbanCard('old1')).toMatchObject({ external_ref: 'TVR-7', scope: 'src' })

    initDatabase(file) // a second start must not fail or lose the values
    expect(getKanbanCard('old1')).toMatchObject({ external_ref: 'TVR-7', scope: 'src' })
  })
})
