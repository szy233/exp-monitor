// Everything the pane computes without the engine: options, the scripts the
// hub runs, parsing what they print, estimates, and the views drawn from them.

import type { Digest, Gpu, HostState, Plan, Run, RunStatus, Snapshot, Stage, StageStatus } from '../types'

export type Options = {
  hub: string
  workers: string[]
  statusDir: string
  intervalSec: number
  staleMin: number
  lostHours: number
  autoInit: boolean
  digests: boolean
  projectRoots: string[]
}

const SAFE_HOST = /^[\w.@-]+$/
const SAFE_PATH = /^[~\w./*@+-]+$/

export function readOptions(raw: Record<string, unknown>): Options {
  const dir = String(raw.statusDir ?? '~/.exp_status').trim()
  const list = (v: unknown, fallback: string) =>
    (Array.isArray(v) ? v.map(String) : String(v ?? fallback).split(','))
      .map(one => one.trim())
      .filter(Boolean)
  return {
    hub: SAFE_HOST.test(String(raw.hub ?? '').trim()) ? String(raw.hub).trim() : '',
    workers: list(raw.workers, 'local').filter(host => SAFE_HOST.test(host)),
    statusDir: SAFE_PATH.test(dir) ? dir.replace(/\/+$/, '') : '~/.exp_status',
    intervalSec: Math.max(10, Number(raw.intervalSec) || 1800),
    staleMin: Math.max(1, Number(raw.staleMin) || 60),
    lostHours: Math.max(1, Number(raw.lostHours) || 6),
    autoInit: raw.autoInit !== false,
    digests: raw.digests !== false,
    projectRoots: list(raw.projectRoots, '~/research/*,~/*').filter(path => SAFE_PATH.test(path)),
  }
}

// What each worker prints: every status file headed by its path, then the
// machine (name, cores, load, memory in MiB) and each GPU with who holds it.
function workerScript(dir: string) {
  return [
    `for f in ${dir}/*.json; do [ -f "$f" ] && { echo "@@FILE $f"; cat "$f"; echo; }; done`,
    `echo "@@SYS $(hostname) $(nproc) $(cut -d' ' -f1 /proc/loadavg) $(free -m | awk '/^Mem:/{print $2, $7}')"`,
    'if command -v nvidia-smi >/dev/null 2>&1; then',
    '  echo @@GPU; nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
    '  echo @@APPS; nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits | while IFS=", " read u p m; do echo "$u,$m,$(ps -o user= -p "$p" 2>/dev/null)"; done',
    'fi',
    'true',
  ].join('\n')
}

// Every script goes to `sh -s` on standard input, never through a login
// shell's own parsing (zsh stops a whole line at a glob that matches nothing).
const heredoc = (tag: string, body: string) => `<<'${tag}'\n${body}\n${tag}`

/** The one script a refresh runs on the hub. */
export function hubScript(opts: Options): string {
  const hosts = opts.workers.join(' ')
  const configs = opts.projectRoots.map(root => `${root}/.claude/exp-monitor.json`).join(' ')
  return [
    't=$(mktemp -d)',
    `cat > "$t/w.sh" ${heredoc('EXP_WORKER', workerScript(opts.statusDir))}`,
    `for h in ${hosts}; do (if [ "$h" = local ]; then sh "$t/w.sh"; else ssh -o BatchMode=yes -o ConnectTimeout=6 "$h" sh -s < "$t/w.sh"; fi) > "$t/$h.out" 2>&1 || echo "@@ERR" >> "$t/$h.out" & done`,
    'wait',
    `for h in ${hosts}; do echo "@@HOST $h"; cat "$t/$h.out"; done`,
    'rm -rf "$t"',
    // Each initialized project on the hub: its config and its latest records,
    // the git log where it is a repository, else the tail of its newest notes.
    'echo "@@HUB"',
    `for f in ${configs}; do [ -f "$f" ] || continue; r=\${f%/.claude/exp-monitor.json}; echo "@@ROOT $r"; cat "$f"; echo`,
    '  if git -C "$r" rev-parse -q --verify HEAD >/dev/null 2>&1; then echo "@@SIG $(git -C "$r" rev-parse --short HEAD)"; git -C "$r" log -n 20 --date=format:%m-%d --format="%ad %s" | cut -c1-220',
    '  else n=$(ls -t "$r"/research/*.md "$r"/*.md 2>/dev/null | head -n 1); if [ -n "$n" ]; then echo "@@SIG $(stat -c %Y "$n" 2>/dev/null)"; echo "# $(basename "$n")"; tail -n 40 "$n" | cut -c1-220; fi; fi',
    '  echo "@@END"; done; true',
  ].join('\n')
}

/** Moves status files into `<dir>/archive/<date>/` on their hosts: nothing is deleted. */
export function archiveScript(opts: Options, files: { where: string; file: string }[]): string | undefined {
  const byHost = new Map<string, string[]>()
  for (const { where, file } of files) {
    if (!SAFE_HOST.test(where) || !/^\/[\w./@+-]+\.json$/.test(file) || file.includes('/archive/')) continue
    byHost.set(where, [...(byHost.get(where) ?? []), file])
  }
  if (byHost.size === 0) return undefined
  return [...byHost]
    .map(([where, paths]) => {
      const move = heredoc('EXP_MOVE', `d=${opts.statusDir}/archive/$(date +%Y%m%d); mkdir -p "$d" && mv -f -- ${paths.join(' ')} "$d"/`)
      return where === 'local' ? `sh -s ${move}` : `ssh -o BatchMode=yes -o ConnectTimeout=6 ${where} sh -s ${move}`
    })
    .join('\n')
}

/** How a script reaches the hub: there through ssh, or here when this is it; the script on stdin. */
export const onHub = (opts: Options) =>
  opts.hub ? ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', opts.hub, 'sh', '-s'] : ['sh', '-s']

const RUN_STATUSES: RunStatus[] = ['queued', 'running', 'done', 'failed', 'killed']
const STAGE_STATUSES: StageStatus[] = ['todo', 'active', 'done', 'failed', 'skipped']
const num = (raw: Record<string, unknown>, key: string) =>
  typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined

function toRun(raw: Record<string, unknown>, where: string, file?: string): Run | undefined {
  const id = String(raw.id ?? raw.name ?? '')
  if (!id) return undefined
  return {
    id,
    project: String(raw.project ?? 'default'),
    stage: String(raw.stage ?? 'other'),
    name: String(raw.name ?? id),
    host: String(raw.host ?? where),
    status: RUN_STATUSES.includes(raw.status as RunStatus) ? (raw.status as RunStatus) : 'queued',
    step: num(raw, 'step'),
    rate: num(raw, 'rate'),
    spark: Array.isArray(raw.spark) ? (raw.spark as unknown[]).filter((v): v is number => typeof v === 'number').slice(-40) : undefined,
    sparkName: raw.sparkName === undefined ? undefined : String(raw.sparkName),
    total: num(raw, 'total'),
    started: num(raw, 'started'),
    updated: num(raw, 'updated'),
    finished: num(raw, 'finished'),
    metrics: typeof raw.metrics === 'object' && raw.metrics !== null ? (raw.metrics as Record<string, number | string>) : undefined,
    note: raw.note === undefined || raw.note === null ? undefined : String(raw.note),
    where,
    file,
  }
}

function toPlan(raw: Record<string, unknown>, where: string, file?: string): Plan | undefined {
  if (!raw.project || !Array.isArray(raw.stages)) return undefined
  const stages: Stage[] = []
  for (const one of raw.stages as unknown[]) {
    if (typeof one === 'string') stages.push({ id: one, title: one })
    else if (typeof one === 'object' && one !== null) {
      const s = one as Record<string, unknown>
      if (!s.id) continue
      stages.push({
        id: String(s.id),
        title: String(s.title ?? s.id),
        goal: s.goal === undefined ? undefined : String(s.goal),
        status: STAGE_STATUSES.includes(s.status as StageStatus) ? (s.status as StageStatus) : undefined,
      })
    }
  }
  const status = ['active', 'done', 'failed', 'paused'].includes(raw.status as string) ? (raw.status as Plan['status']) : undefined
  return {
    project: String(raw.project),
    title: String(raw.title ?? raw.project),
    stages,
    current: raw.current === undefined ? undefined : String(raw.current),
    status,
    updated: num(raw, 'updated') ?? 0,
    where,
    file,
  }
}

/** A project's latest records as the hub printed them. */
export type Notes = { project: string; root: string; sig: string; text: string }

export type Parsed = { runs: Run[]; plans: Plan[]; hosts: HostState[]; notes: Notes[] }

export function parse(stdout: string): Parsed {
  const runs: Run[] = []
  const plans = new Map<string, Plan>()
  const hosts: HostState[] = []
  const notes: Notes[] = []
  let host: HostState | undefined
  let chunk: { file?: string; lines: string[] } | undefined
  let section: 'files' | 'gpu' | 'apps' | 'hub' = 'files'
  let noise: string[] = []
  const uuids = new Map<string, Gpu>()
  let root: { path: string; config: string[]; sig: string; text: string[]; inConfig: boolean } | undefined

  const closeFile = () => {
    if (!chunk || !host) return (chunk = undefined)
    try {
      const raw = JSON.parse(chunk.lines.join('\n')) as Record<string, unknown>
      if (raw.kind === 'plan') {
        const plan = toPlan(raw, host.host, chunk.file)
        const had = plan && plans.get(plan.project)
        if (plan && (!had || plan.updated >= had.updated)) plans.set(plan.project, plan)
      } else {
        const run = toRun(raw, host.host, chunk.file)
        if (run) {
          runs.push(run)
          host.count += 1
        }
      }
    } catch {
      // A file mid-write or not ours: skipped until the next refresh.
    }
    chunk = undefined
  }
  const closeHost = () => {
    closeFile()
    if (host && !host.isOk) host.error = noise.join(' ').slice(0, 160) || 'ssh 失败'
    host = undefined
    noise = []
    uuids.clear()
  }
  const closeRoot = () => {
    if (!root) return
    try {
      const config = JSON.parse(root.config.join('\n')) as { project?: unknown; skip?: unknown }
      if (typeof config.project === 'string' && !config.skip && root.sig) {
        notes.push({ project: config.project, root: root.path, sig: root.sig, text: root.text.join('\n').slice(-4000) })
      }
    } catch {
      // An unreadable config names no project.
    }
    root = undefined
  }

  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (section === 'hub') {
      if (text.startsWith('@@ROOT ')) {
        closeRoot()
        root = { path: text.slice(7), config: [], sig: '', text: [], inConfig: true }
      } else if (!root) continue
      else if (text.startsWith('@@SIG ')) {
        root.inConfig = false
        root.sig = text.slice(6)
      } else if (text === '@@END') closeRoot()
      else if (root.inConfig) root.config.push(line)
      else root.text.push(line)
      continue
    }
    if (text.startsWith('@@HOST ')) {
      closeHost()
      host = { host: text.slice(7), isOk: true, count: 0 }
      hosts.push(host)
      section = 'files'
    } else if (text === '@@HUB') {
      closeHost()
      section = 'hub'
    } else if (text === '@@FILE' || text.startsWith('@@FILE ')) {
      closeFile()
      chunk = { file: text.slice(7) || undefined, lines: [] }
    } else if (text === '@@ERR') {
      closeFile()
      if (host) host.isOk = false
    } else if (text.startsWith('@@SYS ') && host) {
      closeFile()
      const [name, cpus, load, memTotal, memAvail] = text.slice(6).split(/\s+/)
      host.hostname = name
      host.cpus = Number(cpus) || undefined
      host.load = Number(load)
      host.memTotal = Number(memTotal) || undefined
      host.memAvail = Number(memAvail) || undefined
    } else if (text === '@@GPU' && host) {
      section = 'gpu'
      host.gpus = []
    } else if (text === '@@APPS') {
      section = 'apps'
    } else if (section === 'gpu' && host?.gpus && text) {
      const [index, uuid, name, util, used, total] = text.split(/,\s*/)
      const gpu: Gpu = {
        index: Number(index),
        name: (name ?? '').replace(/^NVIDIA\s+/, ''),
        util: Number(util) || 0,
        memUsed: Number(used) || 0,
        memTotal: Number(total) || 0,
        users: [],
      }
      if (Number.isFinite(gpu.index)) {
        host.gpus.push(gpu)
        if (uuid) uuids.set(uuid, gpu)
      }
    } else if (section === 'apps' && text) {
      const [uuid, , user] = text.split(',')
      const gpu = uuid ? uuids.get(uuid) : undefined
      const who = (user ?? '').trim()
      if (gpu && who && !gpu.users.includes(who)) gpu.users.push(who)
    } else if (chunk) {
      chunk.lines.push(line)
    } else if (text && section === 'files') {
      noise.push(text)
    }
  }
  closeHost()
  closeRoot()
  return { runs, plans: [...plans.values()], hosts, notes }
}

const pad = (n: number) => String(n).padStart(2, '0')
export const clock = (sec: number) => {
  const d = new Date(sec * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// Data arrives every half hour, so a duration is told in half hours:
// `<30min`, `~1h`, `~1.5h`, ..., then half days from a day on.
export const span = (sec: number) => {
  const s = Math.max(0, sec)
  if (s < 1800) return '<30min'
  if (s < 86400 - 900) return `~${Math.max(1, Math.round(s / 1800) / 2)}h`
  return `~${Math.round(s / 43200) / 2}d`
}
export const pct = (ratio: number) => `${Math.round(ratio * 100)}%`
export const clamp = (ratio: number) => Math.min(1, Math.max(0, ratio))

// A terminal draws a thin line: `━━━━━╸────`.
export const lineBar = (ratio: number, width: number): [string, string] => {
  const cells = clamp(ratio) * width
  const full = Math.floor(cells)
  const tip = full < width && cells - full >= 0.5 ? '╸' : ''
  return ['━'.repeat(full) + tip, '─'.repeat(width - full - tip.length)]
}

export const runKey = (run: Run) => `${run.where}|${run.project}|${run.id}`

// Stale and lost are judged at the fetch, not at the clock: between fetches
// nothing new can arrive, so only the jobs' own silence counts.
export const isStale = (run: Run, at: number, opts: Options) =>
  run.status === 'running' && run.updated !== undefined && at - run.updated > opts.staleMin * 60
export const isLost = (run: Run, at: number, opts: Options) =>
  run.status === 'running' && run.updated !== undefined && at - run.updated > opts.lostHours * 3600

export function runRatio(run: Run): number | undefined {
  if (run.status === 'done') return 1
  if (run.status === 'failed' || run.status === 'killed') return undefined
  return run.total ? Math.min(1, (run.step ?? 0) / run.total) : 0
}

/** Points a run was seen at: when its file said it was written, and its step. */
export type History = Record<string, [number, number][]>

/**
 * Adds this fetch's points and settles each running run's rate. The trend over
 * the last hours wins: it is what the run actually covered, evaluation and
 * checkpoint pauses included. Without one yet, the job's own loop rate (which
 * leaves those pauses out); then the average since a start old enough to
 * trust. A run registered mid-training has neither, and gets no estimate.
 */
export function estimate(runs: Run[], had: History, at: number): { runs: Run[]; history: History } {
  const history: History = {}
  const out = runs.map(run => {
    if (run.status !== 'running' || run.step === undefined || run.updated === undefined) return run
    const key = runKey(run)
    const points = [...(had[key] ?? [])]
    const last = points[points.length - 1]
    if (!last || run.updated > last[0]) {
      // A step that went back is a restart: the old points no longer describe it.
      if (last && run.step < last[1]) points.length = 0
      points.push([run.updated, run.step])
    }
    const recent = points.filter(([t]) => t >= at - 6 * 3600).slice(-24)
    history[key] = recent
    const first = recent[0]
    const end = recent[recent.length - 1]
    if (first && end && end[0] - first[0] >= 20 * 60 && end[1] > first[1]) {
      return { ...run, estRate: (end[1] - first[1]) / (end[0] - first[0]), estFrom: 'trend' as const }
    }
    if (run.rate && run.rate > 0) return { ...run, estRate: run.rate, estFrom: 'job' as const }
    if (run.started !== undefined && run.updated - run.started >= 1800 && run.step > 0) {
      return { ...run, estRate: run.step / (run.updated - run.started), estFrom: 'average' as const }
    }
    return run
  })
  return { runs: out, history }
}

/** Seconds left, counted down from the run's last report; undefined when there is no rate. */
export function eta(run: Run, now: number): number | undefined {
  if (run.status !== 'running' || run.step === undefined || !run.total || !run.updated || !run.estRate) return undefined
  return Math.max(0, (run.total - run.step) / run.estRate - (now - run.updated))
}

export function leftText(run: Run, now: number): string {
  const left = eta(run, now)
  if (left === undefined) return run.total && run.step !== undefined ? '估算中' : ''
  return left === 0 ? '即将完成' : `剩 ${span(left)}`
}

export type StageView = Stage & { status: StageStatus; runs: Run[]; ratio: number }
export type ProjectView = {
  project: string
  title: string
  plan?: Plan
  stages: StageView[]
  current?: StageView
  ratio: number
  runs: Run[]
  live: Run[]
  lost: Run[]
  queued: Run[]
  ended: Run[]
  lastActive: number
  isIdle: boolean
  digest?: Digest
}

function inferStage(runs: Run[]): StageStatus {
  if (runs.length === 0) return 'todo'
  if (runs.some(run => run.status === 'running' || run.status === 'queued')) return 'active'
  if (runs.every(run => run.status === 'done')) return 'done'
  if (runs.some(run => run.status === 'done')) return 'active'
  return 'failed'
}

export function projects(snap: Snapshot, opts: Options): ProjectView[] {
  const at = snap.fetchedAt || Math.floor(Date.now() / 1000)
  const names = new Set([...snap.plans.map(plan => plan.project), ...snap.runs.map(run => run.project)])
  const views: ProjectView[] = []
  for (const project of names) {
    const runs = snap.runs.filter(run => run.project === project)
    const plan = snap.plans.find(one => one.project === project)
    // Without a plan the stages are the ones the runs name, by first start.
    const declared: Stage[] = plan?.stages.length
      ? [...plan.stages]
      : [...new Set([...runs].sort((a, b) => (a.started ?? 0) - (b.started ?? 0)).map(run => run.stage))].map(id => ({ id, title: id }))
    for (const run of runs) if (!declared.some(stage => stage.id === run.stage)) declared.push({ id: run.stage, title: run.stage })
    const stages: StageView[] = declared.map(stage => {
      const mine = runs.filter(run => run.stage === stage.id && !isLost(run, at, opts))
      const status = stage.status ?? inferStage(mine)
      const ratios = mine.map(runRatio).filter((r): r is number => r !== undefined)
      const ratio = status === 'done' ? 1 : status === 'todo' || ratios.length === 0 ? 0 : ratios.reduce((a, b) => a + b, 0) / ratios.length
      return { ...stage, status, runs: mine, ratio }
    })
    const counted = stages.filter(stage => stage.status !== 'skipped')
    const lost = runs.filter(run => isLost(run, at, opts))
    const live = runs.filter(run => run.status === 'running' && !isLost(run, at, opts))
    const queued = runs.filter(run => run.status === 'queued')
    const ended = runs.filter(run => run.status === 'done' || run.status === 'failed' || run.status === 'killed')
    // The plan's current stage, unless it is finished and a later one has
    // started: plans are written by hand and lag behind the runs.
    const named = stages.findIndex(stage => stage.id === plan?.current)
    const later = named >= 0 ? stages.slice(named + 1).find(stage => stage.status === 'active') : undefined
    const current =
      (named >= 0 && (stages[named]!.status === 'done' || stages[named]!.status === 'skipped') && later) ||
      stages[named] ||
      [...stages].reverse().find(stage => stage.runs.some(run => run.status === 'running')) ||
      stages.find(stage => stage.status !== 'done' && stage.status !== 'skipped')
    const lastActive = Math.max(0, plan?.updated ?? 0, ...runs.map(run => run.updated ?? run.started ?? 0))
    views.push({
      project,
      title: plan?.title ?? project,
      plan,
      stages,
      current,
      ratio: plan?.status === 'done' ? 1 : counted.length ? counted.reduce((a, s) => a + s.ratio, 0) / counted.length : 0,
      runs,
      live,
      lost,
      queued,
      ended,
      lastActive,
      // Nothing running, and either closed by cc or quiet for three days.
      isIdle: live.length === 0 && (plan?.status === 'done' || plan?.status === 'failed' || plan?.status === 'paused' || at - lastActive > 3 * 86400),
      digest: snap.digests[project],
    })
  }
  return views.sort((a, b) => b.live.length - a.live.length || b.lastActive - a.lastActive)
}

export type Step = { title: string; status: StageStatus; ratio: number; isCurrent: boolean; group?: number }

/**
 * At most `room` nodes: the finished stages before the current one fold into
 * one node, and the stages past what fits fold into a last one.
 */
export function windowSteps(view: ProjectView, room: number): Step[] {
  const short = view.digest?.short ?? {}
  const steps: Step[] = view.stages.map(stage => ({
    title: short[stage.id] || stage.title,
    status: stage.status,
    ratio: stage.ratio,
    isCurrent: stage.id === view.current?.id,
  }))
  if (steps.length <= room) return steps
  const at = Math.max(0, steps.findIndex(step => step.isCurrent))
  const head = steps.slice(0, at)
  const out: Step[] = []
  if (head.length > 1) {
    const ended = head.filter(step => step.status === 'done' || step.status === 'skipped').length
    out.push({ title: `已完成 ${ended}`, status: 'done', ratio: 1, isCurrent: false, group: head.length })
  } else out.push(...head)
  const left = Math.max(1, room - out.length - 1)
  const tail = steps.slice(at)
  out.push(...tail.slice(0, left))
  const rest = tail.length - left
  if (rest > 0) out.push({ title: `还有 ${rest}`, status: 'todo', ratio: 0, isCurrent: false, group: rest })
  return out
}

/** The prompt that asks the model for a project's two lines and short stage names. */
export function digestPrompt(view: ProjectView, notes: Notes): string {
  const stages = view.stages
    .map(stage => `- ${stage.id}｜${stage.title}｜${stage.status}${stage.goal ? `｜${stage.goal}` : ''}`)
    .join('\n')
  const running = view.live.map(run => `${run.name}(${run.stage})`).join('、') || '无'
  return [
    `项目：${view.title}`,
    `当前阶段：${view.current?.id ?? '未定'}`,
    `阶段（id｜标题｜状态｜目标）：\n${stages}`,
    `正在运行：${running}`,
    `最近的实验记录（新的在前或在后，按文件原样）：\n${notes.text}`,
    '',
    '为监控面板写极简状态，只输出一个 JSON 对象，不要别的文字：',
    '{"now": "正在做什么，具体到实验或判定名，≤18 个汉字", "next": "下一步，≤18 个汉字，没有就省略", "short": {"<阶段 id>": "≤6 个汉字或 8 个字符的短名"}}',
    '用实验记录里最新的事实，不要编造；英文术语保留原样。',
  ].join('\n')
}

export function readDigest(text: string, sig: string): Digest | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const short: Record<string, string> = {}
    if (typeof raw.short === 'object' && raw.short !== null) {
      for (const [id, name] of Object.entries(raw.short as Record<string, unknown>)) {
        if (typeof name === 'string' && name.trim()) short[id] = name.trim().slice(0, 12)
      }
    }
    const line = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : undefined)
    return { sig, now: line(raw.now), next: line(raw.next), short }
  } catch {
    return undefined
  }
}

export function summary(snap: Snapshot, opts: Options, now: number): string {
  if (snap.fetchedAt === 0) return '还没有取到实验状态。'
  const views = projects(snap, opts)
  const live = views.reduce((n, view) => n + view.live.length, 0)
  const machine = new Map(snap.hosts.flatMap(host => [host.host, ...(host.aliases ?? [])].map(alias => [alias, host.hostname ?? host.host] as const)))
  const hostOf = (run: Run) => (run.host === run.where ? machine.get(run.where) ?? run.host : run.host)
  const lines = [`${clock(snap.fetchedAt)} 同步 · ${views.length} 个项目 · ${live} 个运行中`]
  for (const view of views.filter(one => !one.isIdle)) {
    const done = view.stages.filter(stage => stage.status === 'done').length
    lines.push(
      `- ${view.title}：${pct(view.ratio)}，阶段 ${done}/${view.stages.length}` +
        (view.digest?.now ? `，正在 ${view.digest.now}` : view.current ? `，当前「${view.current.title}」` : ''),
    )
    for (const run of view.live) {
      const left = leftText(run, now)
      lines.push(
        `  - ● ${run.name} @${hostOf(run)}` +
          (run.total && run.step !== undefined ? ` ${pct(runRatio(run) ?? 0)}` : '') +
          (left ? ` ${left}` : '') +
          (isStale(run, snap.fetchedAt, opts) ? '（停滞）' : ''),
      )
    }
    for (const run of view.ended.filter(one => one.status === 'failed')) lines.push(`  - ✖ ${run.name}${run.note ? `：${run.note}` : ''}`)
    if (view.lost.length) lines.push(`  - 失联 ${view.lost.length} 个（超过 ${opts.lostHours} 小时没有更新）`)
  }
  const idle = views.filter(one => one.isIdle).length
  if (idle) lines.push(`- 另有 ${idle} 个闲置项目`)
  for (const host of snap.hosts.filter(one => !one.isOk)) lines.push(`- 无法连接 ${host.host}：${host.error}`)
  return lines.join('\n')
}
