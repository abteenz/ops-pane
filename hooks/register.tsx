import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CallStatus, FileKind, FileTouch, LedgerEntry, Subagent, Usage } from '../types'

// Observe only: every hook passes `e` to `next` unchanged and returns what
// `next` answered, and every bookkeeping step is wrapped so a failure here
// can never refuse, rewrite or hold up a tool call, a spawn or a turn.

const PANE = 'ops'
const TITLE = 'Ops'
const LOG_ROWS = 15
const FILE_ROWS = 5
const LEDGER_CAP = 5000
const HISTORY_CAP = 40
const ARG_CAP = 1000

const files = atom({ plugin: 'ops-pane', key: 'files' } as const, [])
const ledger = atom({ plugin: 'ops-pane', key: 'ledger' } as const, [])
const total = atom({ plugin: 'ops-pane', key: 'total' } as const, 0)
const agents = atom({ plugin: 'ops-pane', key: 'agents' } as const, [])
const EMPTY_USAGE: Usage = { history: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const usage = atom({ plugin: 'ops-pane', key: 'usage' } as const, EMPTY_USAGE)

const LIVE = new Set(['pending', 'running', 'waiting'])
const SPARK = '▁▂▃▄▅▆▇█'

const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // An observer that fails stays silent: the session goes on untouched.
  }
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const clockTime = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => `${n}`.padStart(2, '0')).join(':')
}

const relative = (path: string, cwd: string) =>
  cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

/** The tool's own arguments, long strings cut so the ledger stays small. */
const argsOf = (input: Record<string, unknown>) => {
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k)) continue
    args[k] =
      typeof v === 'string' && v.length > ARG_CAP
        ? `${v.slice(0, ARG_CAP)}…(+${v.length - ARG_CAP} chars)`
        : v
  }
  return args
}

const summarize = (tool: string, a: Record<string, unknown>, cwd: string) => {
  const path = str(a.file_path) ?? str(a.notebook_path)
  if (tool === 'Bash') return cut(oneLine(str(a.command) ?? ''), 60)
  if (path !== undefined) return relative(path, cwd)
  if (tool === 'Agent') return cut(`${str(a.subagent_type) ?? 'general-purpose'}: ${str(a.description) ?? ''}`, 60)
  if (tool === 'TodoWrite' && Array.isArray(a.todos)) return `${a.todos.length} todos`
  const first =
    str(a.pattern) ?? str(a.url) ?? str(a.query) ?? str(a.skill) ??
    Object.values(a).find((v): v is string => typeof v === 'string')
  return first === undefined ? '' : cut(oneLine(first), 60)
}

const touchKind = (tool: string, result: unknown): FileKind | undefined => {
  if (tool === 'Read') return 'read'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edited'
  if (tool === 'Write') {
    const type = (result as { type?: unknown } | undefined)?.type
    return type === 'create' ? 'created' : 'edited'
  }
  return undefined
}

const agentEnd = (reason: string) =>
  reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'

/** Brings each tracked subagent's status up to what the engine lists now. */
const reconcile = async ($: EngineInterface) => {
  const listed = await $.agent.list()
  const byId = new Map(listed.map(a => [a.id, a.status]))
  const now = await $.clock.now()
  await update($, agents, list =>
    list.map(a => {
      const status = byId.get(a.id)
      if (status === undefined || status === a.status) return a
      return { ...a, status, endedAt: LIVE.has(status) ? undefined : (a.endedAt ?? now) }
    }),
  )
}

export const register: Register = on => {
  // The module's own copy of the working directory, for shortening paths.
  let cwd = ''

  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      cwd = await $.session.cwd()
    })
    await $.command.register({ name: 'ops', description: 'Toggle the ops pane (files, tool calls, subagents, context)' })
    await $.command.register({
      name: 'ops-export',
      description: 'Write this session’s tool-call ledger as JSONL to .claude/logs/<session-id>.jsonl',
    })
    // While any subagent is live, follow its status from the engine's list.
    $.clock.every(3000, async () => {
      await quietly(async () => {
        const list = await read($, agents)
        if (list.some(a => LIVE.has(a.status))) await reconcile($)
      })
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await quietly(async () => {
        await update($, files, () => [])
        await update($, ledger, () => [])
        await update($, total, () => 0)
        await update($, agents, () => [])
        await update($, usage, () => EMPTY_USAGE)
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id ?? `call-${Math.random().toString(36).slice(2)}`
    const args = argsOf(e as unknown as Record<string, unknown>)

    await quietly(async () => {
      const entry: LedgerEntry = {
        id,
        tool,
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
        summary: summarize(tool, args, cwd),
        input: args,
        startedAt: await $.clock.now(),
        status: 'running',
      }
      await update($, ledger, list => [...list, entry].slice(-LEDGER_CAP))
      await update($, total, n => n + 1)
    })

    const ran = await next(e)

    await quietly(async () => {
      const status: CallStatus =
        ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
      const endedAt = await $.clock.now()
      const error = ran.deny ?? (ran.isError === true ? cut(ran.text ?? '', 300) : undefined)
      await update($, ledger, list =>
        list.map(one =>
          one.id === id ? { ...one, status, endedAt, ...(error === undefined ? {} : { error }) } : one,
        ),
      )

      const path = str(args.file_path) ?? str(args.notebook_path)
      const kind = status === 'ok' && path !== undefined ? touchKind(tool, ran.result) : undefined
      if (path === undefined || kind === undefined) return
      await update($, files, list => {
        const found = list.find(f => f.path === path && f.kind === kind)
        const touch: FileTouch = { path, kind, count: (found?.count ?? 0) + 1, lastAt: endedAt }
        return [touch, ...list.filter(f => f !== found)]
      })
    })

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    await quietly(async () => {
      if (spawned.agentId === undefined) return
      const agent: Subagent = {
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description,
        prompt: e.prompt,
        status: 'running',
        startedAt: await $.clock.now(),
      }
      await update($, agents, list => [...list.filter(a => a.id !== agent.id), agent])
    })

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      const used = e.usage
      if (used !== undefined) {
        await update($, usage, u => ({
          ...u,
          input: u.input + used.input_tokens,
          output: u.output + used.output_tokens,
          cacheRead: u.cacheRead + used.cache_read_input_tokens,
          cacheWrite: u.cacheWrite + used.cache_creation_input_tokens,
        }))
      }
      const agentId = e.agentId
      if (agentId === undefined) return
      const now = await $.clock.now()
      await update($, agents, list =>
        list.map(a =>
          a.id === agentId && LIVE.has(a.status) ? { ...a, status: agentEnd(e.reason), endedAt: now } : a,
        ),
      )
      // A teammate goes idle rather than ending: the engine's list says so.
      await reconcile($)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await quietly(async () => {
      const { percent, tokens, window } = e.context
      if (!e.changed.includes('context') || percent === undefined) return
      await update($, usage, u => ({
        ...u,
        contextPercent: percent,
        contextTokens: tokens,
        window,
        history: [...u.history, percent].slice(-HISTORY_CAP),
      }))
    })

    return next(e)
  })

  on('command.run', { command: 'ops' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Ops pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return { text: opened.isPlaced ? 'Ops pane opened.' : `Ops pane opened, waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'ops-export' }, async $ => {
    const entries = await read($, ledger)
    const count = await read($, total)
    const id = await $.session.id()
    const root = (await $.session.repo())?.root ?? (await $.session.cwd())
    const path = `${root}/.claude/logs/${id}.jsonl`
    const text = entries.map(one => JSON.stringify(one)).join('\n') + (entries.length > 0 ? '\n' : '')
    await $.fs.write(path, text)
    const dropped = count - entries.length
    return {
      text:
        `Wrote ${entries.length} tool calls to ${path}` +
        (dropped > 0 ? ` (the oldest ${dropped} fell out of the ${LEDGER_CAP}-call ledger).` : '.'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const calls = await read($, total)
    const live = (await read($, agents)).filter(a => LIVE.has(a.status)).length
    if (u.contextPercent === undefined && calls === 0) return next(e)

    const { Text } = $.ui.resolve(e)
    const ctx = u.contextPercent === undefined ? 'ctx –' : `ctx ${u.contextPercent}%`
    const ctxColor = (u.contextPercent ?? 0) >= 80 ? 'error' : (u.contextPercent ?? 0) >= 60 ? 'warning' : undefined

    return (
      <Text wrap="truncate-end" dimColor>
        <Text color={ctxColor}>{ctx}</Text>
        {` · ${calls} tool call${calls === 1 ? '' : 's'} · ${live} subagent${live === 1 ? '' : 's'} active`}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const u = await read($, usage)
    const touched = await read($, files)
    const calls = await read($, ledger)
    const callCount = await read($, total)
    const subs = await read($, agents)

    const header = (label: string, extra: string) => (
      <Text wrap="truncate-end">
        <Text bold color="claude">{label}</Text>
        <Text dimColor>{extra}</Text>
      </Text>
    )

    // Context and tokens
    const spark = u.history
      .slice(-Math.max(5, Math.min(HISTORY_CAP, width - 40)))
      .map(p => SPARK[Math.min(SPARK.length - 1, Math.floor((p / 100) * SPARK.length))])
      .join('')
    const inTotal = u.input + u.cacheRead + u.cacheWrite
    const ctxLine =
      u.contextPercent === undefined
        ? 'no reading yet'
        : `${u.contextPercent}% of ${short(u.window ?? 0)} (${short(u.contextTokens ?? 0)} tokens)`
    const pctColor = (u.contextPercent ?? 0) >= 80 ? 'error' : (u.contextPercent ?? 0) >= 60 ? 'warning' : 'success'

    // Files, grouped, most recent first
    const groups: [FileKind, string][] = [['read', 'Read'], ['edited', 'Edited'], ['created', 'Created']]
    const fileRows = groups.map(([kind, label]) => {
      const list = touched.filter(f => f.kind === kind).sort((a, b) => b.lastAt - a.lastAt)
      const times = list.reduce((n, f) => n + f.count, 0)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>{label.padEnd(8)}</Text>
            <Text dimColor>{list.length} file{list.length === 1 ? '' : 's'}, {times}×</Text>
          </Text>
          {list.slice(0, FILE_ROWS).map(f => (
            <Text wrap="truncate-start">
              {'  '}
              {relative(f.path, cwd)}
              <Text dimColor>{f.count > 1 ? ` ×${f.count}` : ''}</Text>
            </Text>
          ))}
          {list.length > FILE_ROWS && <Text dimColor>{`  +${list.length - FILE_ROWS} more`}</Text>}
        </Box>
      )
    })

    // Last tool calls, newest first
    const mark = (s: CallStatus) =>
      s === 'running' ? <Text color="warning">…</Text>
        : s === 'ok' ? <Text color="success">✓</Text>
        : s === 'denied' ? <Text color="warning">⊘</Text>
        : <Text color="error">✗</Text>
    const toolWidth = 12
    const callRows = calls.slice(-LOG_ROWS).reverse().map(c => (
      <Text wrap="truncate-end">
        <Text dimColor>{clockTime(c.startedAt)} </Text>
        {mark(c.status)}
        {' '}
        <Text bold>{cut(c.tool, toolWidth).padEnd(toolWidth)}</Text>
        <Text dimColor>{c.agentId === undefined ? '' : '↳ '}</Text>
        {c.summary}
      </Text>
    ))

    // Subagents: live ones first, then the most recent finished
    const live = subs.filter(a => LIVE.has(a.status))
    const done = subs.filter(a => !LIVE.has(a.status)).reverse()
    const agentRows = [...live, ...done].slice(0, 8).map(a => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {LIVE.has(a.status) ? <Text color="warning">● </Text> : <Text dimColor>○ </Text>}
          <Text bold>{a.type}</Text>
          <Text dimColor>{` ${a.status} · `}</Text>
          {a.description}
        </Text>
        <Text wrap="truncate-end" dimColor>{`    ${oneLine(a.prompt)}`}</Text>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        {header('CONTEXT ', '')}
        <Text wrap="truncate-end">
          <Text color={pctColor}>{ctxLine}</Text>
          <Text dimColor>{spark === '' ? '' : `  ${spark}`}</Text>
        </Text>
        <Text wrap="truncate-end" dimColor>
          {`session in ${short(inTotal)} (${short(u.cacheRead)} cache read, ${short(u.cacheWrite)} cache write) · out ${short(u.output)}`}
        </Text>
        <Text> </Text>
        {header('FILES ', `${touched.length === 0 ? 'none yet' : ''}`)}
        {touched.length > 0 && fileRows}
        <Text> </Text>
        {header('TOOL CALLS ', `last ${Math.min(LOG_ROWS, calls.length)} of ${callCount}`)}
        {callRows.length === 0 ? <Text dimColor>none yet</Text> : callRows}
        <Text> </Text>
        {header('SUBAGENTS ', `${subs.length} launched · ${live.length} running`)}
        {agentRows.length === 0 ? <Text dimColor>none yet</Text> : agentRows}
      </Box>
    )
  })
}
