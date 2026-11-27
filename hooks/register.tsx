import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClusterState, Digest, HostState, ProjectConfig, Run, RunStatus, Setup, Snapshot, View } from '../types'
import {
  type Fleet,
  type History,
  type Notes,
  type Options,
  type ProjectView,
  archiveScript,
  clock,
  digestPrompt,
  estimate,
  eta,
  hubScript,
  isLost,
  isStale,
  leftText,
  lineBar,
  onHub,
  parse,
  pct,
  projects,
  readDigest,
  readOptions,
  runKey,
  runRatio,
  shortName,
  span,
  summary,
  totals,
  windowSteps,
  withFleet,
} from './data'
import { clusterRuns, slurmStatus } from './slurm'
import { HUE, bar as svgBar, gpus as svgGpus, meters, pills, ring, stepper } from './svg'

export { span } from './data'

const PANE = 'exp-monitor'
const TITLE = '实验进度'
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'exp-monitor', key: 'snapshot' } as const,
  { runs: [], plans: [], hosts: [], digests: {}, fetchedAt: 0, isFetching: false } as Snapshot,
  { shape: 'snapshot-3' },
)
const view = atom(
  { plugin: 'exp-monitor', key: 'view' } as const,
  { tab: 'exp', detail: [], more: [], showIdle: false } as View,
  { shape: 'view-1' },
)
const setup = atom(
  { plugin: 'exp-monitor', key: 'setup' } as const,
  { cwd: '', state: 'missing', config: {} } as Setup,
  { shape: 'setup-1' },
)

const CONFIG_FILE = '.claude/exp-monitor.json'
const INIT_PROMPT = `[exp-monitor 初始化] 这是本项目第一次打开实验监控面板，请按 exp-monitor 技能完成初始化：
1. 阅读项目（README、CLAUDE.md、故事线/论文大纲、预注册、实验配置与脚本），确定项目 id（短 ASCII）和中文标题。
2. 根据故事线设计 4–7 个实验阶段，先用表格给我确认，再写入计划文件；项目已有计划时先问我。
3. 摸清服务器情况：从 ~/.ssh/config 和项目脚本里找出本项目会用到的服务器，逐台检查免密 ssh、python3、~/.exp_status/exp_status.py（缺了就从中枢复制过去）和 GPU 占用（nvidia-smi），汇总成一张表。
4. 写 ${CONFIG_FILE}：{"project": "<id>", "title": "<标题>", "workers": ["local", ...]}，workers 只放能免密连上的服务器（从中枢看的别名，local 表示中枢本机）。
5. 列出项目里需要接入 ExpStatus 上报的训练/派发脚本位置，先不改，问我。
如果这不是实验项目，回复一句即可，并写 {"skip": true} 到 ${CONFIG_FILE}。`

const ICON: Record<RunStatus | 'lost', string> = {
  queued: '○',
  running: '●',
  done: '✔',
  failed: '✖',
  killed: '■',
  lost: '◌',
}
const COLOR: Record<RunStatus | 'lost', string> = {
  queued: 'subtle',
  running: 'suggestion',
  done: 'success',
  failed: 'error',
  killed: 'warning',
  lost: 'warning',
}

let fetching: Promise<void> | undefined
let isWatching = false
let digesting: Promise<void> | undefined
// The last attempt per project, so a failing model is asked again only after an hour.
const tried = new Map<string, { sig: string; at: number }>()

// The project's own file may name another hub or status folder. Its machines
// do not narrow the view: every session reads every project's (withFleet).
function effective(opts: Options, config: ProjectConfig): Options {
  const own = Object.fromEntries(Object.entries({ hub: config.hub, statusDir: config.statusDir }).filter(([, v]) => v !== undefined))
  return readOptions({ ...opts, ...own })
}

// The views drawn from one snapshot, computed once however often it is drawn.
let memo: { key: string; views: ProjectView[] } | undefined
function viewsOf(snap: Snapshot, opts: Options): ProjectView[] {
  const key = [
    snap.fetchedAt,
    snap.runs.length,
    snap.plans.length,
    Object.values(snap.digests)
      .map(one => one.sig)
      .join(','),
    opts.lostHours,
  ].join('|')
  if (memo?.key !== key) memo = { key, views: projects(snap, opts) }
  return memo.views
}

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === 'object' && value !== null && Array.isArray((value as Snapshot).runs) && typeof (value as Snapshot).fetchedAt === 'number'

// Every session shares the last fetch: a new one draws it at once and only
// fetches again when it is more than five minutes old.
async function restore($: EngineInterface): Promise<number> {
  const had = await read($, snapshot)
  if (had.fetchedAt) return had.fetchedAt
  const kept = await $.store.get('snapshot')
  if (!isSnapshot(kept)) return 0
  await update($, snapshot, (): Snapshot => ({ ...kept, digests: kept.digests ?? {}, isFetching: false }))
  return kept.fetchedAt
}

async function loadSetup($: EngineInterface, cwd: string): Promise<Setup> {
  let config: ProjectConfig | undefined
  try {
    const raw = JSON.parse(await $.fs.read(`${cwd}/${CONFIG_FILE}`)) as unknown
    if (typeof raw === 'object' && raw !== null) config = raw as ProjectConfig
  } catch {
    config = undefined
  }
  const had = await read($, setup)
  const state = config
    ? config.skip
      ? 'skipped'
      : 'ready'
    : had.cwd === cwd && had.state === 'started'
      ? 'started'
      : (await $.store.get(`init:${cwd}`))
        ? 'started'
        : 'missing'
  const next: Setup = { cwd, state, config: config ?? {} }
  await update($, setup, () => next)
  return next
}

// A home, root or temp folder is no project, nor one holding nothing a project
// holds: neither is initialized unasked.
const MARKERS =
  /^(\.git|README(\..+)?|CLAUDE\.md|pyproject\.toml|setup\.py|requirements.*\.txt|environment\.ya?ml|Makefile|configs?|scripts|src|experiments?|train.*\.py|.+\.(py|ipynb|tex|sh|ya?ml))$/i

async function isProjectDir($: EngineInterface, cwd: string): Promise<boolean> {
  if (/^(\/|\/tmp\/?.*|\/(home|Users)\/[^/]+\/?|\/root\/?)$/.test(cwd)) return false
  try {
    return (await $.fs.list(cwd)).some(entry => MARKERS.test(entry.name))
  } catch {
    return false
  }
}

async function startInit($: EngineInterface, cwd: string) {
  await $.store.set(`init:${cwd}`, Math.floor(Date.now() / 1000))
  await update($, setup, (one): Setup => ({ ...one, state: 'started' }))
  await $.prompt.submit({ text: INIT_PROMPT })
}

async function showUp($: EngineInterface, opts: Options, cwd: string) {
  void $.ui.open({ id: PANE, title: TITLE })
  const now = await loadSetup($, cwd)
  if (opts.autoInit && now.state === 'missing' && (await isProjectDir($, cwd))) await startInit($, cwd)
  if (Date.now() / 1000 - (await restore($)) > 300) void refresh($, opts)
}

async function watchSetup($: EngineInterface, opts: Options) {
  const had = await read($, setup)
  if (!had.cwd) return
  const now = await loadSetup($, had.cwd)
  if (had.state !== 'ready' && now.state === 'ready') void refresh($, opts)
}

/** Files archived from the pane: hidden while what they say stays the same. */
type Dismissed = Record<string, string>
const fileKey = (where: string, file: string) => `${where}|${file}`
const runMark = (run: Run) => (run.status === 'running' || run.status === 'queued' ? `${run.status}|${run.step ?? ''}` : run.status)

// Two aliases that reach one machine are one machine: its files are read once.
function mergeHosts(hosts: HostState[], runs: Run[]): { hosts: HostState[]; runs: Run[] } {
  const first = new Map<string, HostState>()
  const dropped = new Set<string>()
  const kept: HostState[] = []
  for (const host of hosts) {
    const twin = host.hostname ? first.get(host.hostname) : undefined
    if (twin && host.isOk) {
      twin.aliases = [...(twin.aliases ?? []), host.host]
      dropped.add(host.host)
      continue
    }
    if (host.hostname && host.isOk) first.set(host.hostname, host)
    kept.push(host)
  }
  return { hosts: kept, runs: runs.filter(run => !dropped.has(run.where)) }
}

// A refresh asked while one runs waits for that one instead of starting another.
// A refresh the person asked for shows 同步中…; the timer and start-up ones
// fetch quietly, so the pane redraws once, when the new data is in.
function refresh($: EngineInterface, base: Options, isAsked = false): Promise<void> {
  fetching ??= fetchAll($, base, false, isAsked).finally(() => (fetching = undefined))
  return fetching
}

const sameFleet = (a: Fleet, b: Fleet) =>
  a.workers.join(' ') === b.workers.join(' ') && a.clusters.join(' ') === b.clusters.join(' ')

async function fetchAll($: EngineInterface, base: Options, isAgain = false, isAsked = false) {
  const had = await read($, setup)
  if (had.cwd) await loadSetup($, had.cwd)
  const { state, config } = await read($, setup)
  // Outside an initialized project nothing is fetched until the person asks.
  if (state !== 'ready' && !isWatching) return
  const known = ((await $.store.get('fleet')) ?? { workers: [], clusters: [] }) as Fleet
  const opts = withFleet(effective(base, config), known)
  if (isAsked && !isAgain) await update($, snapshot, snap => ({ ...snap, isFetching: true }))
  try {
    const ran = await $.process.run(onHub(opts), { stdin: hubScript(opts), timeoutMs: 90_000 })
    const parsed = parse(ran.stdout)
    // The projects name their machines; one this fetch did not read is read
    // straight away, once, and every later fetch reads it too.
    const fleet: Fleet = { workers: [...new Set(parsed.fleet.workers)].sort(), clusters: [...new Set(parsed.fleet.clusters)].sort() }
    if (!sameFleet(fleet, known)) {
      await $.store.set('fleet', fleet)
      const wider = withFleet(effective(base, config), fleet)
      const isMissing = [...wider.workers, ...wider.clusters].some(host => ![...opts.workers, ...opts.clusters].includes(host))
      if (isMissing && !isAgain) return await fetchAll($, base, true, isAsked)
    }
    const merged = mergeHosts(parsed.hosts, parsed.runs)
    const dismissed = ((await $.store.get('dismissed')) ?? {}) as Dismissed
    const at = Math.floor(Date.now() / 1000)
    // Cluster jobs join the runs: the scheduler's facts on the ones that
    // report, runs of their own for the ones that do not.
    const withJobs = clusterRuns(
      merged.runs,
      parsed.plans,
      merged.hosts.flatMap(host => (host.cluster ? [{ where: host.host, cluster: host.cluster }] : [])),
      parsed.notes,
      at,
    )
    const shown = withJobs.runs.filter(run => dismissed[fileKey(run.where, run.file ?? run.id)] !== runMark(run))
    const plans = withJobs.plans.filter(plan => !plan.file || dismissed[fileKey(plan.where, plan.file)] !== `plan|${plan.updated}`)
    const { runs, history } = estimate(shown, ((await $.store.get('history')) ?? {}) as History, at)
    await $.store.set('history', history)
    const failure = merged.hosts.length === 0 ? (ran.stderr.trim() || `退出码 ${ran.exitCode}`).slice(0, 200) : undefined
    const next = await update($, snapshot, snap => ({
      runs,
      plans,
      hosts: merged.hosts,
      digests: snap.digests,
      fetchedAt: at,
      isFetching: false,
      error: failure,
    }))
    if (!failure) await $.store.set('snapshot', next)
    await announce($, runs)
    digesting ??= digestAll($, opts, parsed.notes).finally(() => (digesting = undefined))
  } catch (error) {
    await update($, snapshot, snap => ({ ...snap, isFetching: false, error: String(error).slice(0, 200) }))
  }
}

// A project's two lines come from its latest records, asked of the model only
// when those records changed; every session reuses the answer.
async function digestAll($: EngineInterface, opts: Options, notes: Notes[]) {
  const views = viewsOf(await read($, snapshot), opts)
  const found: Record<string, Digest> = {}
  for (const note of notes) {
    const one = views.find(view => view.project === note.project)
    if (!one) continue
    // The lines describe the records and what runs now: either changing asks again.
    const sig = `v2|${note.sig}#${one.live.map(run => run.id).sort().join(',')}`
    const cached = (await $.store.get(`digest:${note.project}`)) as Digest | undefined
    let digest = cached?.sig === sig ? cached : undefined
    const last = tried.get(note.project)
    const isFresh = last?.sig === sig && Date.now() - last.at < 3600_000
    if (!digest && opts.digests && !isFresh) {
      tried.set(note.project, { sig, at: Date.now() })
      const answer = await $.model.complete({
        model: 'haiku',
        prompt: digestPrompt(one, note),
        maxTokens: 400,
        effort: 'low',
        timeoutMs: 60_000,
      })
      digest = answer.isAnswered ? readDigest(answer.text, sig) : undefined
      if (digest) await $.store.set(`digest:${note.project}`, digest)
    }
    const shown = digest ?? cached
    if (shown) found[note.project] = shown
  }
  if (Object.keys(found).length) {
    const next = await update($, snapshot, snap => ({ ...snap, digests: { ...snap.digests, ...found } }))
    await $.store.set('snapshot', next)
  }
}

// Archiving moves the files on their machines; the pane also remembers what
// they said, so a writer that puts the same file back does not bring it back.
async function archive($: EngineInterface, base: Options, runs: Run[], planOf?: ProjectView) {
  const { config } = await read($, setup)
  const opts = effective(base, config)
  const files = runs.flatMap(run => (run.file ? [{ where: run.where, file: run.file }] : []))
  const plan = planOf?.plan
  if (plan?.file) files.push({ where: plan.where, file: plan.file })
  // A job seen only through the scheduler has no file: clearing it only hides it.
  const script = archiveScript(opts, files)
  if (!script && runs.every(run => run.file)) return
  if (script) {
    const ran = await $.process.run(onHub(opts), { stdin: script, timeoutMs: 60_000 })
    if (ran.exitCode !== 0) {
      void $.ui.toast(`归档失败：${(ran.stderr.trim() || `退出码 ${ran.exitCode}`).slice(0, 80)}`)
      return
    }
  }
  const dismissed = ((await $.store.get('dismissed')) ?? {}) as Dismissed
  for (const run of runs) dismissed[fileKey(run.where, run.file ?? run.id)] = runMark(run)
  if (plan?.file) dismissed[fileKey(plan.where, plan.file)] = `plan|${plan.updated}`
  await $.store.set('dismissed', dismissed)
  await update($, snapshot, snap => ({
    ...snap,
    runs: snap.runs.filter(run => !runs.some(gone => runKey(gone) === runKey(run))),
    plans: plan ? snap.plans.filter(one => one.project !== plan.project) : snap.plans,
  }))
  await update($, view, (one): View => ({ ...one, confirm: undefined, manage: planOf ? undefined : one.manage }))
  const hidden = runs.filter(run => !run.file).length
  void $.ui.toast(
    files.length
      ? `已归档 ${files.length} 个状态文件（${opts.statusDir}/archive/ 下可找回）${hidden ? `，另隐藏 ${hidden} 个集群作业` : ''}`
      : `已隐藏 ${hidden} 个集群作业`,
  )
}

// Each finished or failed run is announced once, by whichever session sees it
// first: the record is shared, so switching sessions repeats nothing. Only a
// run that ended in the last six hours is news; the first record ever is a
// baseline that announces nothing.
async function announce($: EngineInterface, runs: Run[]) {
  const at = Math.floor(Date.now() / 1000)
  const had = (await $.store.get('announced')) as Record<string, number> | undefined
  const next: Record<string, number> = {}
  for (const [key, when] of Object.entries(had ?? {})) if (at - when < 7 * 86400) next[key] = when
  for (const run of runs) {
    if (run.status !== 'done' && run.status !== 'failed') continue
    const key = `${runKey(run)}|${run.status}`
    if (next[key] !== undefined) continue
    next[key] = at
    if (!had || at - (run.finished ?? run.updated ?? 0) > 6 * 3600) continue
    const text = `${ICON[run.status]} ${shortName(run.name)} ${run.status === 'done' ? '已完成' : '失败'}`
    void $.ui.toast(text)
    void $.ui.notify(text, { title: TITLE })
  }
  await $.store.set('announced', next)
}

const gb = (mib?: number) => (mib === undefined ? '?' : `${Math.round(mib / 1024)}G`)

export const register: Register = (on, options) => {
  const opts = readOptions(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'exp', description: '打开实验进度面板并立即刷新' })
    await $.command.register({ name: 'exp-status', description: '以文字汇总当前实验进度' })
    await $.command.register({ name: 'exp-init', description: '让 cc 为本项目初始化实验监控（阶段设计、服务器检查）' })
    await loadSetup($, e.cwd)
    await restore($)
    $.clock.every(opts.intervalSec * 1000, () => void refresh($, opts))
    // The project file is cheap to read: a minute after cc writes it the band
    // has its project, with no wait for the next half-hourly fetch.
    $.clock.every(60_000, () => void watchSetup($, opts))
    // A terminal draws from the start; the desktop app attaches a moment later.
    if (e.surface) await showUp($, opts, e.cwd)
    else if (Date.now() / 1000 - (await read($, snapshot)).fetchedAt > 300) void refresh($, opts)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await showUp($, opts, (await read($, setup)).cwd || (await $.session.cwd()))

    return attached
  })

  on('command.run', { command: 'exp' }, async $ => {
    isWatching = true
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($, opts, true)

    return { text: '实验进度面板已打开，正在刷新。' }
  })

  on('command.run', { command: 'exp-status' }, async $ => {
    isWatching = true
    await refresh($, opts, true)
    // The summary waits for the lines the model is writing, if any.
    await digesting
    const { config } = await read($, setup)

    return { text: summary(await read($, snapshot), effective(opts, config), Math.floor(Date.now() / 1000)) }
  })

  on('command.run', { command: 'exp-init' }, async $ => {
    const { cwd } = await read($, setup)
    await startInit($, cwd || (await $.session.cwd()))

    return { text: '已让 cc 开始初始化本项目的实验监控。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const here = await read($, setup)
    if (e.props.hasSurvey || here.state === 'skipped' || !here.cwd) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const openPane = () => {
      isWatching = true
      void $.ui.open({ id: PANE, title: TITLE })
      void refresh($, opts, true)
    }
    const openButton = <Button key="exp-open" label="实验面板" variant="primary" onPress={openPane} />

    if (here.state !== 'ready') {
      return (
        <Box flexDirection="row" justifyContent="flex-end" gap={1}>
          <Text dimColor wrap="truncate">
            {here.state === 'started' ? '实验监控初始化中…' : '本项目未初始化实验监控'}
          </Text>
          {here.state === 'missing' && <Button key="exp-init" label="初始化" onPress={() => void startInit($, here.cwd)} />}
          {openButton}
        </Box>
      )
    }

    const eff = effective(opts, here.config)
    const snap = await read($, snapshot)
    const one = viewsOf(snap, eff).find(p => p.project === here.config.project)
    const live = one?.live ?? []
    const now = Math.floor(Date.now() / 1000)
    const lefts = live.map(run => leftText(run, now)).filter(text => text.startsWith('剩') || text === '即将完成')
    const [full, empty] = lineBar(one?.ratio ?? 0, Math.max(6, Math.min(16, e.props.bodyColumns - 50)))
    const doing = one?.digest?.now ?? one?.current?.title

    return (
      <Box flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1}>
        <Text wrap="truncate">
          <Text dimColor>{here.config.title ?? here.config.project ?? '实验'} </Text>
          {doing && <Text>{doing} </Text>}
          {!Svg && (
            <Text>
              <Text color="claude">{full}</Text>
              <Text dimColor>{empty}</Text>{' '}
            </Text>
          )}
        </Text>
        {Svg && one && <Svg source={ring(one.ratio, 16, HUE.accent, false)} alt={pct(one.ratio)} width={16} height={16} />}
        <Text dimColor wrap="truncate">
          <Text>{pct(one?.ratio ?? 0)}</Text>
          {' · '}
          {live.length} 运行中{lefts[0] ? ` · ${lefts.sort()[0]}` : ''}
        </Text>
        {openButton}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const snap = await read($, snapshot)
    const ui = await read($, view)
    const here = await read($, setup)
    const eff = effective(opts, here.config)
    const now = Math.floor(Date.now() / 1000)
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    // A pixel is about a seventh of a cell in the app's panes.
    const px = Math.max(160, cols * 7)
    const isNarrow = cols < 44
    const mine = here.config.project
    // The session's own project leads, open; the rest follow by activity.
    const all = [...viewsOf(snap, eff)].sort((a, b) => Number(b.project === mine) - Number(a.project === mine))
    const active = all.filter(one => !one.isIdle || one.project === mine)
    const idle = all.filter(one => one.isIdle && one.project !== mine)
    const open =
      ui.open ??
      (active.some(one => one.project === mine) ? mine : undefined) ??
      active.find(one => one.live.length > 0)?.project ??
      active[0]?.project
    const set = (change: (one: View) => View) => void update($, view, change)
    const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter(one => one !== id) : [...list, id])
    const down = snap.hosts.filter(host => !host.isOk)
    const sum = totals(all, now)
    const gpuAll = snap.hosts.flatMap(host => host.gpus ?? [])
    const gpuBusy = gpuAll.filter(gpu => gpu.util >= 10).length
    const hub = snap.hosts.find(host => host.host === 'local')?.hostname ?? 'local'
    // A run's place in a few letters: a cluster job's node, else the alias it was read through.
    const placeOf = (run: Run) => {
      const place = run.slurm?.node ?? (run.host !== run.where ? run.host : run.where === 'local' ? hub : run.where)
      return place.length > 10 ? `${place.slice(0, 9)}…` : place
    }
    const dateOf = (sec: number) => {
      const d = new Date(sec * 1000)
      return `${d.getMonth() + 1}-${d.getDate()} ${clock(sec)}`
    }
    const short = (sec: number) => span(sec).replace('<30min', '<30m')

    const strip = (items: { n: number; label: string; color: string; theme: string }[], key: string) => {
      const shown = items.filter(item => item.n > 0)
      if (shown.length === 0) return null
      const drawn = Svg ? pills(shown.map(item => ({ count: item.n, label: item.label, color: item.color }))) : undefined
      // Wider than the pane, the strip scales down whole rather than losing its end.
      const scale = drawn ? Math.min(1, px / drawn.width) : 1
      return Svg && drawn ? (
        <Svg
          key={key}
          source={drawn.source}
          alt={shown.map(item => `${item.n} ${item.label}`).join(' · ')}
          width={Math.floor(drawn.width * scale)}
          height={Math.ceil(drawn.height * scale)}
        />
      ) : (
        <Text key={key}>
          {shown.map((item, i) => (
            <Text>
              {i > 0 ? '  ' : ''}
              <Text color={item.theme}>{item.n}</Text>
              <Text dimColor> {item.label}</Text>
            </Text>
          ))}
        </Text>
      )
    }

    const tab = (id: View['tab'], label: string) => (
      <Button key={`tab-${id}`} plain onPress={() => set(one => ({ ...one, tab: id }))}>
        <Text bold={ui.tab === id} dimColor={ui.tab !== id} underline={ui.tab === id}>
          {label}
        </Text>
      </Button>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" gap={2}>
          {tab('exp', '任务')}
          {tab('srv', '资源')}
        </Box>
        <Button key="refresh" hotkey="r" plain onPress={() => void refresh($, opts, true)}>
          <Text dimColor>{snap.isFetching ? '同步中…' : snap.fetchedAt ? `${clock(snap.fetchedAt)} ⟳` : '⟳'}</Text>
        </Button>
      </Box>
    )

    const notices = (
      <Box flexDirection="column">
        {here.state === 'missing' && here.cwd && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color="warning">本项目未初始化</Text>
            <Button key="pane-init" label="初始化" onPress={() => void startInit($, here.cwd)} />
          </Box>
        )}
        {here.state === 'started' && <Text dimColor>cc 正在初始化本项目…</Text>}
        {snap.error && <Text color="error">同步失败：{snap.error}</Text>}
        {down.length > 0 && ui.tab === 'exp' && (
          <Button key="down" plain onPress={() => set(one => ({ ...one, tab: 'srv' }))}>
            <Text color="warning">⚠ {down.length} 台机器连不上</Text>
          </Button>
        )}
      </Box>
    )

    const miniBar = (ratio: number, hue: string, theme: string, width = 46) =>
      Svg ? (
        <Svg source={svgBar(ratio, width, hue, 4)} alt={pct(ratio)} width={width} height={4} />
      ) : (
        <Text>
          <Text color={theme}>{lineBar(ratio, 6)[0]}</Text>
          <Text dimColor>{lineBar(ratio, 6)[1]}</Text>
        </Text>
      )

    // A run in one line, its columns aligned: state, name, place, bar, %, time.
    const runLine = (run: Run) => {
      const stale = isStale(run, snap.fetchedAt, eff)
      const hasSteps = Boolean(run.total && run.step !== undefined)
      const ratio = runRatio(run) ?? 0
      const left = eta(run, now)
      const time = stale
        ? `停 ${short(snap.fetchedAt - (run.updated ?? snap.fetchedAt))}`
        : left !== undefined
          ? left === 0
            ? '将完成'
            : short(left)
          : hasSteps
            ? '估算中'
            : run.started !== undefined
              ? `已 ${short(now - run.started)}`
              : ''
      return (
        <Box key={`run-${runKey(run)}`} flexDirection="row" alignItems="center" gap={1}>
          <Text color={stale ? 'warning' : 'suggestion'}>●</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-middle">{shortName(run.name)}</Text>
          </Box>
          {!isNarrow && (
            <Box width={10} flexShrink={0}>
              <Text dimColor wrap="truncate">
                {placeOf(run)}
              </Text>
            </Box>
          )}
          <Box width={7} flexShrink={0}>
            {hasSteps ? miniBar(ratio, stale ? HUE.stale : HUE.running, stale ? 'warning' : 'suggestion') : <Text dimColor>{Svg ? '' : '      '}</Text>}
          </Box>
          <Box width={4} flexShrink={0} justifyContent="flex-end">
            <Text bold>{hasSteps ? pct(ratio) : ''}</Text>
          </Box>
          <Box width={7} flexShrink={0} justifyContent="flex-end">
            <Text dimColor={!stale} color={stale ? 'warning' : undefined}>
              {time}
            </Text>
          </Box>
        </Box>
      )
    }

    const detailRow = (one: ProjectView, run: Run) => {
      const lost = isLost(run, snap.fetchedAt, eff)
      const kind = lost ? 'lost' : run.status
      const stage = one.digest?.short?.[run.stage] ?? one.stages.find(s => s.id === run.stage)?.title ?? run.stage
      const took = run.started !== undefined ? (run.finished ?? run.updated ?? run.started) - run.started : undefined
      const job = run.slurm
      const when = lost
        ? `失联 ${short(snap.fetchedAt - (run.updated ?? snap.fetchedAt))}`
        : run.status === 'queued'
          ? ['排队', job?.reason, job?.start ? `预计 ${dateOf(job.start)}` : ''].filter(Boolean).join(' · ')
          : took !== undefined && took > 0
            ? `用时 ${short(took)}`
            : ''
      const why = run.note && (run.status === 'failed' || run.status === 'killed') ? shortName(run.note) : ''
      return (
        <Box key={`row-${runKey(run)}`} flexDirection="row" alignItems="center" gap={1}>
          <Text color={COLOR[kind]}>{ICON[kind]}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate">
              {shortName(run.name)}
              <Text dimColor> {[stage, placeOf(run), when].filter(Boolean).join(' · ')}</Text>
              {why && <Text color="error"> {why}</Text>}
            </Text>
          </Box>
          {(run.status !== 'running' || lost) && (
            <Button key={`rm-${runKey(run)}`} plain onPress={() => void archive($, opts, [run])}>
              <Text dimColor>✕</Text>
            </Button>
          )}
        </Box>
      )
    }

    const card = (one: ProjectView) => {
      const doneStages = one.stages.filter(stage => stage.status === 'done').length
      const count = (status: RunStatus) => one.ended.filter(run => run.status === status).length
      const order: Record<string, number> = { lost: 0, failed: 1, killed: 2, queued: 3, done: 4 }
      const listed = [...one.lost, ...one.ended, ...one.queued].sort(
        (a, b) =>
          (order[isLost(a, snap.fetchedAt, eff) ? 'lost' : a.status] ?? 9) - (order[isLost(b, snap.fetchedAt, eff) ? 'lost' : b.status] ?? 9) ||
          (b.finished ?? b.updated ?? 0) - (a.finished ?? a.updated ?? 0),
      )
      const isDetail = ui.detail.includes(one.project)
      const isManage = ui.manage === one.project
      const clearable = [...one.ended, ...one.lost]
      const showAll = ui.more.includes(one.project)
      const shownLive = showAll ? one.live : one.live.slice(0, 6)
      const doing = one.digest?.now ?? one.current?.title
      const room = Math.max(3, Math.min(7, Math.floor(px / 62)))
      const ended = strip(
        [
          { n: count('done'), label: '完成', color: HUE.done, theme: 'success' },
          { n: count('failed'), label: '失败', color: HUE.failed, theme: 'error' },
          { n: count('killed'), label: '中止', color: HUE.stale, theme: 'warning' },
          { n: one.lost.length, label: '失联', color: HUE.stale, theme: 'warning' },
          { n: one.queued.length, label: '排队', color: HUE.label, theme: 'subtle' },
        ],
        `ended-${one.project}`,
      )

      return (
        <Box key={`card-${one.project}`} flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg && one.stages.length > 0 && (
              <Svg source={ring(one.ratio, 28, HUE.accent)} alt={`总进度 ${pct(one.ratio)}`} width={28} height={28} />
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate">
                {one.title}
                {one.stages.length > 0 && (
                  <Text dimColor>
                    {'  '}
                    {Svg ? '' : `${pct(one.ratio)} · `}阶段 {doneStages}/{one.stages.length}
                  </Text>
                )}
              </Text>
              {doing && (
                <Text dimColor wrap="truncate">
                  {doing}
                </Text>
              )}
            </Box>
            <Button key={`close-${one.project}`} plain onPress={() => set(v => ({ ...v, open: '' }))}>
              <Text dimColor>▴</Text>
            </Button>
          </Box>
          {one.stages.length > 0 && Svg && (
            <Svg
              source={stepper(windowSteps(one, room), px)}
              alt={one.stages.map(stage => `${stage.status === 'done' ? '✔' : stage.id === one.current?.id ? '●' : '○'}${stage.title}`).join(' ')}
              width={px}
              height={42}
            />
          )}
          {one.live.length > 0 && (
            <Box flexDirection="column">
              {shownLive.map(runLine)}
              {one.live.length > 6 && (
                <Button key={`more-${one.project}`} plain onPress={() => set(v => ({ ...v, more: toggleIn(v.more, one.project) }))}>
                  <Text dimColor>{showAll ? '收起' : `还有 ${one.live.length - 6} 个 ▾`}</Text>
                </Button>
              )}
            </Box>
          )}
          {(ended || one.plan) && (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              {ended ?? <Text> </Text>}
              <Box flexDirection="row" gap={2}>
                {listed.length > 0 && (
                  <Button key={`detail-${one.project}`} plain onPress={() => set(v => ({ ...v, detail: toggleIn(v.detail, one.project) }))}>
                    <Text dimColor>{isDetail ? '收起' : '明细'}</Text>
                  </Button>
                )}
                <Button
                  key={`manage-${one.project}`}
                  plain
                  onPress={() => set(v => ({ ...v, manage: v.manage === one.project ? undefined : one.project, confirm: undefined }))}
                >
                  <Text dimColor>管理</Text>
                </Button>
              </Box>
            </Box>
          )}
          {isManage && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {clearable.length > 0 &&
                (ui.confirm === `clear:${one.project}` ? (
                  <Button key={`clear-${one.project}`} label={`确认清理 ${clearable.length} 个`} variant="primary" onPress={() => void archive($, opts, clearable)} />
                ) : (
                  <Button key={`clear-${one.project}`} label={`清理已结束 ${clearable.length}`} onPress={() => set(v => ({ ...v, confirm: `clear:${one.project}` }))} />
                ))}
              {ui.confirm === `archive:${one.project}` ? (
                <Button key={`archive-${one.project}`} label="确认归档项目" variant="primary" onPress={() => void archive($, opts, one.runs, one)} />
              ) : (
                <Button key={`archive-${one.project}`} label="归档项目" onPress={() => set(v => ({ ...v, confirm: `archive:${one.project}` }))} />
              )}
              <Button key={`cancel-${one.project}`} label="取消" role="dismiss" onPress={() => set(v => ({ ...v, manage: undefined, confirm: undefined }))} />
            </Box>
          )}
          {isDetail && (
            <Box flexDirection="column">
              {listed.slice(0, 15).map(run => detailRow(one, run))}
              {listed.length > 15 && <Text dimColor>…共 {listed.length} 个，其余可在“管理”里一并清理</Text>}
            </Box>
          )}
        </Box>
      )
    }

    const row = (one: ProjectView) => {
      const lefts = one.live.map(run => eta(run, now)).filter((t): t is number => t !== undefined)
      const state = one.live.length
        ? `${one.live.length} 运行${lefts.length ? ` · ${short(Math.min(...lefts))}` : ''}`
        : one.queued.length
          ? `${one.queued.length} 排队`
          : one.plan?.status === 'done'
            ? '已完成'
            : one.plan?.status === 'failed'
              ? '已终止'
              : '空闲'
      return (
        <Box key={`row-${one.project}`} flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg source={ring(one.ratio, 14, one.live.length ? HUE.accent : HUE.label, false)} alt={pct(one.ratio)} width={14} height={14} />
          ) : (
            <Text color={one.live.length ? 'suggestion' : 'subtle'}>{one.live.length ? '●' : '○'}</Text>
          )}
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`open-${one.project}`} plain onPress={() => set(v => ({ ...v, open: one.project, manage: undefined, confirm: undefined }))}>
              <Text wrap="truncate">{one.title}</Text>
            </Button>
          </Box>
          <Text dimColor>{state}</Text>
        </Box>
      )
    }

    const tasks = (
      <Box flexDirection="column" gap={1}>
        {strip(
          [
            { n: sum.running, label: '运行', color: HUE.running, theme: 'suggestion' },
            { n: sum.queued, label: '排队', color: HUE.label, theme: 'subtle' },
            { n: sum.doneToday, label: '今日完成', color: HUE.done, theme: 'success' },
            { n: sum.failed, label: '失败', color: HUE.failed, theme: 'error' },
            { n: sum.lost, label: '失联', color: HUE.stale, theme: 'warning' },
          ],
          'totals',
        )}
        {snap.fetchedAt > 0 && all.length === 0 && <Text dimColor>还没有实验上报状态。</Text>}
        {active.map(one => (one.project === open ? card(one) : row(one)))}
        {idle.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Button key="idle" plain onPress={() => set(v => ({ ...v, showIdle: !v.showIdle }))}>
              <Text dimColor>
                {ui.showIdle ? '▾' : '▸'} 闲置 {idle.length}
              </Text>
            </Button>
            {ui.showIdle && idle.map(one => (one.project === open ? card(one) : row(one)))}
          </Box>
        )}
      </Box>
    )

    // One way of drawing GPUs, for a machine's own and a cluster's jobs' alike.
    type GpuRow = { label: string; util: number; memUsed: number; memTotal: number; note: string; warn?: boolean }
    const gpuRows = (rows: GpuRow[]) => {
      const drawn = Svg ? svgGpus(rows, px) : undefined
      return Svg && drawn ? (
        <Svg
          source={drawn.source}
          alt={rows.map(one => `${one.label} ${one.util}% ${gb(one.memUsed)}/${gb(one.memTotal)} ${one.note}`).join('；')}
          width={px}
          height={drawn.height}
        />
      ) : (
        rows.map(one => (
          <Text wrap="truncate">
            <Text dimColor>{one.label} </Text>
            <Text color={one.util >= 60 ? 'suggestion' : 'subtle'}>{lineBar(one.util / 100, 8)[0]}</Text>
            <Text dimColor>{lineBar(one.util / 100, 8)[1]}</Text> {one.util}%
            <Text dimColor={!one.warn} color={one.warn ? 'warning' : undefined}>
              {' '}
              {gb(one.memUsed)}/{gb(one.memTotal)} · {one.note}
            </Text>
          </Text>
        ))
      )
    }

    // A machine's title line, btop-style: its name, and CPU and memory as meters.
    const machineHead = (name: string, alias: string, isOk: boolean, cpu?: number, mem?: number) => {
      const items = [
        ...(cpu !== undefined ? [{ label: 'CPU', ratio: cpu }] : []),
        ...(mem !== undefined ? [{ label: 'MEM', ratio: mem }] : []),
      ]
      const drawn = Svg && items.length ? meters(items) : undefined
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate">
              <Text color={isOk ? 'success' : 'warning'}>●</Text> <Text bold>{name}</Text>
              {alias && <Text dimColor> {alias}</Text>}
            </Text>
          </Box>
          {Svg && drawn ? (
            <Svg source={drawn.source} alt={items.map(item => `${item.label} ${pct(item.ratio)}`).join(' ')} width={drawn.width} height={drawn.height} />
          ) : (
            <Text dimColor>{items.map(item => `${item.label} ${pct(item.ratio)}`).join('  ')}</Text>
          )}
        </Box>
      )
    }

    // A machine by the shortest of its names: `gpu7` over `lab-Super-Server-7`
    // and `me@10.0.0.7`, `cluster` over `university_cluster_gpu`.
    const nameOfHost = (host: HostState) =>
      [host.cluster?.name, host.hostname, host.host, ...(host.aliases ?? [])]
        .filter((name): name is string => Boolean(name) && name !== 'local')
        .map(name => name.replace(/^[^@]*@/, ''))
        .sort((a, b) => a.length - b.length)[0] ?? host.host

    // A Slurm cluster drawn as a machine: its GPUs are the ones the person's
    // running jobs hold, each with what it does and the time its job has left.
    const clusterCard = (host: HostState, c: ClusterState) => {
      const gpuTotal = c.nodes.reduce((n, node) => n + node.gpus, 0)
      const gpuUsed = c.nodes.reduce((n, node) => n + node.gpusUsed, 0)
      const cpus = c.nodes.reduce((n, node) => n + node.cpus, 0)
      const cpusUsed = c.nodes.reduce((n, node) => n + node.cpusUsed, 0)
      const memAll = c.nodes.reduce((n, node) => n + node.memTotal, 0)
      const memUsed = c.nodes.reduce((n, node) => n + node.memAlloc, 0)
      const running = c.mine.filter(job => slurmStatus(job.state) === 'running')
      const pending = c.mine.filter(job => slurmStatus(job.state) === 'queued')
      const mineGpus = running.reduce((n, job) => n + job.gpus, 0)
      const rows: GpuRow[] = []
      const cpuJobs: { name: string; note: string; warn: boolean }[] = []
      for (const job of running) {
        const left = job.limit !== undefined ? job.limit - job.elapsed - (now - snap.fetchedAt) : undefined
        const isSoon = left !== undefined && left < 12 * 3600
        const limit = left === undefined ? '无时限' : `剩 ${short(Math.max(0, left))}`
        const usage = job.usage?.length ? job.usage : Array.from({ length: job.gpus }, () => undefined)
        if (usage.length === 0) {
          cpuJobs.push({ name: job.name, note: limit, warn: isSoon })
          continue
        }
        for (const gpu of usage) {
          const isIdle = gpu !== undefined && gpu.util < 5
          rows.push({
            label: job.node ?? '?',
            util: gpu?.util ?? 0,
            memUsed: gpu?.memUsed ?? 0,
            memTotal: gpu?.memTotal ?? 0,
            note: [job.name, limit, isIdle ? '空转' : '', gpu ? '' : '读不到'].filter(Boolean).join(' · '),
            warn: isSoon || isIdle,
          })
        }
      }
      return (
        <Box key={`cluster-${host.host}`} flexDirection="column">
          {machineHead(nameOfHost(host), 'Slurm', true, cpus ? cpusUsed / cpus : undefined, memAll ? memUsed / memAll : undefined)}
          {rows.length > 0 && gpuRows(rows)}
          {cpuJobs.map(job => (
            <Text wrap="truncate" dimColor={!job.warn} color={job.warn ? 'warning' : undefined}>
              {job.name} · {job.note}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            {gpuTotal ? `GPU ${gpuUsed}/${gpuTotal} 已分配 · 你 ${mineGpus} · 空闲 ${gpuTotal - gpuUsed}` : `${c.running} 运行`}
            {` · 排队 ${c.pending}`}
            {pending.length ? `（你 ${pending.length}${pending[0]?.reason ? ` · ${pending[0].reason}` : ''}）` : ''}
          </Text>
        </Box>
      )
    }

    const resources = (
      <Box flexDirection="column" gap={1}>
        {strip(
          [
            { n: gpuBusy, label: `卡在忙 · 共 ${gpuAll.length}`, color: HUE.running, theme: 'suggestion' },
            { n: snap.hosts.length - down.length, label: '台在线', color: HUE.done, theme: 'success' },
            { n: down.length, label: '台连不上', color: HUE.stale, theme: 'warning' },
          ],
          'machines',
        )}
        {snap.hosts.length === 0 && <Text dimColor>还没有机器信息，按 ⟳ 同步。</Text>}
        {snap.hosts
          .filter(host => host.isOk)
          .map(host => {
            if (host.cluster) return clusterCard(host, host.cluster)
            const list = host.gpus ?? []
            const cpu = host.cpuPct !== undefined ? host.cpuPct / 100 : host.load !== undefined && host.cpus ? host.load / host.cpus : undefined
            const mem = host.memTotal && host.memAvail !== undefined ? 1 - host.memAvail / host.memTotal : undefined
            return (
              <Box key={`host-${host.host}`} flexDirection="column">
                {machineHead(nameOfHost(host), '', true, cpu, mem)}
                {list.length > 0 &&
                  gpuRows(
                    list.map(gpu => ({
                      label: String(gpu.index),
                      util: gpu.util,
                      memUsed: gpu.memUsed,
                      memTotal: gpu.memTotal,
                      note: gpu.users.join(',') || '空闲',
                    })),
                  )}
              </Box>
            )
          })}
        {down.map(host => (
          <Text key={`down-${host.host}`} color="warning" wrap="truncate">
            ● {host.host} 连不上<Text dimColor> {host.error}</Text>
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notices}
        {ui.tab === 'exp' ? tasks : resources}
      </Box>
    )
  })
}
