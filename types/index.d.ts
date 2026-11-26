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
  /** The Slurm job behind the run, on a cluster. */
  slurm?: SlurmJob
}

/** One of the person's jobs on a Slurm cluster, as squeue or sacct tells it. */
export type SlurmJob = {
  id: string
  name: string
  /** Slurm's own state: RUNNING, PENDING, COMPLETED, FAILED, TIMEOUT, ... */
  state: string
  /** Seconds run so far, and the time limit (undefined when unlimited). */
  elapsed: number
  limit?: number
  node?: string
  /** Why a pending job waits (Priority, Resources, ...). */
  reason?: string
  partition?: string
  gpus: number
  /** When it started, or for a pending job when Slurm expects it to. */
  start?: number
  end?: number
  workdir?: string
  exit?: string
  /** Each of a running job's GPUs as the job itself sees it: load in %, memory in MiB. */
  usage?: { util: number; memUsed: number; memTotal: number }[]
}

export type SlurmNode = {
  name: string
  partition: string
  state: string
  gpus: number
  gpusUsed: number
  cpus: number
  cpusUsed: number
  memTotal: number
  memAlloc: number
}

export type SlurmPartition = { name: string; isUp: boolean; limit?: number; allocated: number; idle: number; other: number; total: number }

export type ClusterState = {
  name?: string
  running: number
  pending: number
  fairShare?: number
  nodes: SlurmNode[]
  partitions: SlurmPartition[]
  mine: SlurmJob[]
  recent: SlurmJob[]
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
  /** Set for a Slurm cluster's login node: the scheduler's view instead of one machine's. */
  cluster?: ClusterState
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
  clusters?: string[]
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
