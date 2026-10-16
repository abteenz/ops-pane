import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SCROLL = { offset: 0, bodyRows: 60 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 95, scroll: SCROLL, view: {} }
const PANE = { title: 'Ops', isFocused: false, bodyColumns: 96, placement: 'inline' as const, scroll: SCROLL, view: {} }
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 } }

/** The engine beneath: tools answer, and /ops-export's write is caught here. */
const engine = (on: On, written: { path: string; text: string }[]) => {
  mock.clock(on)
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('tool.call', ($, e) =>
    e.tool === 'Write'
      ? { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
      : e.tool === 'Read' && e.file_path.endsWith('secret')
        ? { deny: 'nope' }
        : { result: { stdout: 'ok', stderr: '', interrupted: false } },
  )
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
}

const exported = async ($: Engine, written: { text: string }[]) => {
  await $.command.run({ command: 'ops-export', args: '', ...RUN })
  return (written.at(-1)?.text ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('tool calls pass through untouched and land in the ledger', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, written)

  const wrote = await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'x' })
  expect(wrote.result).toMatchObject({ type: 'create', filePath: '/repo/src/new.ts' })
  const ran = await $.tool.call({ tool: 'Bash', command: `echo ${'a'.repeat(100)}` })
  expect(ran.result).toMatchObject({ stdout: 'ok' })
  const denied = await $.tool.call({ tool: 'Read', file_path: '/repo/secret' })
  expect(denied.deny ?? denied.text).toContain('nope')

  const rows = await exported($, written)
  expect(written[0]?.path).toBe('/repo/.claude/logs/sess-123.jsonl')
  expect(rows.map(r => [r.tool, r.status])).toEqual([['Write', 'ok'], ['Bash', 'ok'], ['Read', 'denied']])
  expect(rows[1].summary).toHaveLength(60)
  expect(rows[1].summary.endsWith('…')).toBe(true)
})

test('the band and pane show files, calls, subagents and context', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, written)

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.agent.spawn({
    tool_use_id: 't1', prompt: 'Find the auth code', description: 'find auth', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  await $.session.measure({ context: { window: 200000, tokens: 84000, percent: 42 }, rateLimits: [], changed: ['context'] })

  const band = await $.ui.mount({ plugin: 'ops-pane', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /ctx 42% · 2 tool calls · 1 subagent active/ })).toBeDefined()

  const pane = await $.ui.mount({ plugin: 'ops-pane', surface: 'terminal', component: 'Pane', requestId: 'ops', props: PANE })
  expect(await pane.find({ type: 'Text', text: /42% of 200\.0k/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Created\s+1 file/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /src\/new\.ts/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /git status/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 launched · 1 running/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Find the auth code/ })).toBeDefined()
})
