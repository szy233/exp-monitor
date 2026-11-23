export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'killed'

export type Run = {
  id: string
  project: string
  stage: string
  name: string
  host: string
  status: RunStatus
  step?: number
  /** Steps per second, recent, as the job reports it. */
  rate?: number
  /** Recent values of one metric, oldest first, and its name. */
  spark?: number[]
  sparkName?: string
  total?: number
  started?: number
  updated?: number
  finished?: number
  metrics?: Record<string, number | string>
  note?: string
  /** The worker alias whose status folder holds the file, and the file's path there. */
  where: string
  file?: string
  /** Steps per second the pane estimates, and from what. */
  estRate?: number
  estFrom?: 'trend' | 'job' | 'average'
}

export type StageStatus = 'todo' | 'active' | 'done' | 'failed' | 'skipped'

export type Stage = { id: string; title: string; goal?: string; status?: StageStatus }

export type Plan = {
  project: string
  title: string
  stages: Stage[]
  current?: string
  /** A project's own state when cc marks it: finished, failed or paused. */
  status?: 'active' | 'done' | 'failed' | 'paused'
  updated: number
  where: string
  file?: string
}

export type Gpu = {
  index: number
  name: string
  util: number
  memUsed: number
  memTotal: number
  users: string[]
}

export type HostState = {
  host: string
  isOk: boolean
  count: number
  error?: string
  hostname?: string
  cpus?: number
  load?: number
  memTotal?: number
  memAvail?: number
  gpus?: Gpu[]
  /** Other worker aliases that reach the same machine. */
  aliases?: string[]
}

/** What the model made of a project's recent records. */
export type Digest = {
  sig: string
  now?: string
  next?: string
  short?: Record<string, string>
}

export type Snapshot = {
  runs: Run[]
  plans: Plan[]
  hosts: HostState[]
  digests: Record<string, Digest>
  fetchedAt: number
  isFetching: boolean
  error?: string
}

export type View = {
  tab: 'exp' | 'srv'
  /** The one project drawn open; '' for none, undefined for the default. */
  open?: string
  detail: string[]
  manage?: string
  confirm?: string
  more: string[]
  showIdle: boolean
}

/** `<project>/.claude/exp-monitor.json`, written by cc when it initializes the project. */
export type ProjectConfig = {
  project?: string
  title?: string
  hub?: string
  workers?: string[]
  statusDir?: string
  skip?: boolean
}

/** missing: no config yet; started: cc is initializing; ready / skipped: per the config. */
export type SetupState = 'missing' | 'started' | 'ready' | 'skipped'

export type Setup = { cwd: string; state: SetupState; config: ProjectConfig }

declare module 'claude-code' {
  interface PluginState {
    'exp-monitor': {
      snapshot: Shaped<Snapshot>
      view: Shaped<View>
      setup: Shaped<Setup>
    }
  }
}
