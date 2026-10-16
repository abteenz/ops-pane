export type FileKind = 'read' | 'edited' | 'created'

/** One file under one kind of touch; a file created then edited has two. */
export type FileTouch = { path: string; kind: FileKind; count: number; lastAt: number }

export type CallStatus = 'running' | 'ok' | 'error' | 'denied'

/** One tool call, as the ledger keeps and /ops-export writes it. */
export type LedgerEntry = {
  id: string
  tool: string
  agentId?: string
  summary: string
  input: Record<string, unknown>
  startedAt: number
  endedAt?: number
  status: CallStatus
  error?: string
}

export type Subagent = {
  id: string
  type: string
  description: string
  prompt: string
  status: string
  startedAt: number
  endedAt?: number
}

export type Usage = {
  contextPercent?: number
  contextTokens?: number
  window?: number
  /** Context % at each reading the engine raised, oldest first. */
  history: number[]
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

declare module 'claude-code' {
  interface PluginState {
    'ops-pane': {
      files: FileTouch[]
      ledger: LedgerEntry[]
      total: number
      agents: Subagent[]
      usage: Usage
    }
  }
}
