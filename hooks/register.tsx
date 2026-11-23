import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Digest, HostState, ProjectConfig, Run, RunStatus, Setup, Snapshot, View } from '../types'
import {
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
  span,
  summary,
  windowSteps,
} from './data'
import { HUE, bar as svgBar, gpus as svgGpus, pills, ring, spark, stepper } from './svg'

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
let previous: Map<string, RunStatus> | undefined

// The project's own file wins over the plugin's settings, field by field.
function effective(opts: Options, config: ProjectConfig): Options {
  const own = Object.fromEntries(
    Object.entries({ hub: config.hub, workers: config.workers, statusDir: config.statusDir }).filter(([, v]) => v !== undefined),
  )
  return readOptions({ ...opts, ...own })
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
  void refresh($, opts)
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
function refresh($: EngineInterface, base: Options): Promise<void> {
  fetching ??= fetchAll($, base).finally(() => (fetching = undefined))
  return fetching
}

async function fetchAll($: EngineInterface, base: Options) {
  const had = await read($, setup)
  if (had.cwd) await loadSetup($, had.cwd)
  const { state, config } = await read($, setup)
  // Outside an initialized project nothing is fetched until the person asks.
  if (state !== 'ready' && !isWatching) return
  const opts = effective(base, config)
  await update($, snapshot, snap => ({ ...snap, isFetching: true }))
  try {
    const ran = await $.process.run(onHub(opts), { stdin: hubScript(opts), timeoutMs: 90_000 })
    const parsed = parse(ran.stdout)
    const merged = mergeHosts(parsed.hosts, parsed.runs)
    const dismissed = ((await $.store.get('dismissed')) ?? {}) as Dismissed
    const shown = merged.runs.filter(run => !run.file || dismissed[fileKey(run.where, run.file)] !== runMark(run))
    const plans = parsed.plans.filter(plan => !plan.file || dismissed[fileKey(plan.where, plan.file)] !== `plan|${plan.updated}`)
    const at = Math.floor(Date.now() / 1000)
    const { runs, history } = estimate(shown, ((await $.store.get('history')) ?? {}) as History, at)
    await $.store.set('history', history)
    const failure = merged.hosts.length === 0 ? (ran.stderr.trim() || `退出码 ${ran.exitCode}`).slice(0, 200) : undefined
    await update($, snapshot, snap => ({
      runs,
      plans,
      hosts: merged.hosts,
      digests: snap.digests,
      fetchedAt: at,
      isFetching: false,
      error: failure,
    }))
    announce($, runs)
    digesting ??= digestAll($, opts, parsed.notes).finally(() => (digesting = undefined))
  } catch (error) {
    await update($, snapshot, snap => ({ ...snap, isFetching: false, error: String(error).slice(0, 200) }))
  }
}

// A project's two lines come from its latest records, asked of the model only
// when those records changed; every session reuses the answer.
async function digestAll($: EngineInterface, opts: Options, notes: Notes[]) {
  for (const note of notes) {
      const cached = (await $.store.get(`digest:${note.project}`)) as Digest | undefined
      let digest = cached?.sig === note.sig ? cached : undefined
      const last = tried.get(note.project)
      const isFresh = last?.sig === note.sig && Date.now() - last.at < 3600_000
      if (!digest && opts.digests && !isFresh) {
        tried.set(note.project, { sig: note.sig, at: Date.now() })
        const snap = await read($, snapshot)
        const one = projects(snap, opts).find(view => view.project === note.project)
        if (!one) continue
        const answer = await $.model.complete({
          model: 'haiku',
          prompt: digestPrompt(one, note),
          maxTokens: 400,
          effort: 'low',
          timeoutMs: 60_000,
        })
        digest = answer.isAnswered ? readDigest(answer.text, note.sig) : undefined
        if (digest) await $.store.set(`digest:${note.project}`, digest)
      }
      const found = digest ?? cached
      if (found) await update($, snapshot, snap => ({ ...snap, digests: { ...snap.digests, [note.project]: found } }))
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
  const script = archiveScript(opts, files)
  if (!script) return
  const ran = await $.process.run(onHub(opts), { stdin: script, timeoutMs: 60_000 })
  if (ran.exitCode !== 0) {
    void $.ui.toast(`归档失败：${(ran.stderr.trim() || `退出码 ${ran.exitCode}`).slice(0, 80)}`)
    return
  }
  const dismissed = ((await $.store.get('dismissed')) ?? {}) as Dismissed
  for (const run of runs) if (run.file) dismissed[fileKey(run.where, run.file)] = runMark(run)
  if (plan?.file) dismissed[fileKey(plan.where, plan.file)] = `plan|${plan.updated}`
  await $.store.set('dismissed', dismissed)
  await update($, snapshot, snap => ({
    ...snap,
    runs: snap.runs.filter(run => !runs.some(gone => runKey(gone) === runKey(run))),
    plans: plan ? snap.plans.filter(one => one.project !== plan.project) : snap.plans,
  }))
  await update($, view, (one): View => ({ ...one, confirm: undefined, manage: planOf ? undefined : one.manage }))
  void $.ui.toast(`已归档 ${files.length} 个状态文件（${opts.statusDir}/archive/ 下可找回）`)
}

// The first fetch after a load is the baseline: only later changes notify.
function announce($: EngineInterface, runs: Run[]) {
  if (previous) {
    for (const run of runs) {
      if (previous.get(runKey(run)) === run.status) continue
      if (run.status !== 'done' && run.status !== 'failed') continue
      const text = `${ICON[run.status]} ${run.project} · ${run.name} ${run.status === 'done' ? '已完成' : '失败'}`
      void $.ui.toast(text)
      void $.ui.notify(text, { title: TITLE })
    }
  }
  previous = new Map(runs.map(run => [runKey(run), run.status]))
}

const gb = (mib?: number) => (mib === undefined ? '?' : `${Math.round(mib / 1024)}G`)

export const register: Register = (on, options) => {
  const opts = readOptions(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'exp', description: '打开实验进度面板并立即刷新' })
    await $.command.register({ name: 'exp-status', description: '以文字汇总当前实验进度' })
    await $.command.register({ name: 'exp-init', description: '让 cc 为本项目初始化实验监控（阶段设计、服务器检查）' })
    await loadSetup($, e.cwd)
    $.clock.every(opts.intervalSec * 1000, () => void refresh($, opts))
    // The project file is cheap to read: a minute after cc writes it the band
    // has its project, with no wait for the next half-hourly fetch.
    $.clock.every(60_000, () => void watchSetup($, opts))
    // A terminal draws from the start; the desktop app attaches a moment later.
    if (e.surface) await showUp($, opts, e.cwd)
    else void refresh($, opts)

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
    void refresh($, opts)

    return { text: '实验进度面板已打开，正在刷新。' }
  })

  on('command.run', { command: 'exp-status' }, async $ => {
    isWatching = true
    await refresh($, opts)
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
      void refresh($, opts)
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
    const one = projects(snap, eff).find(p => p.project === here.config.project)
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
    const cols = Math.max(20, e.props.bodyColumns ?? 40)
    // A pixel is about a seventh of a cell in the app's panes.
    const px = Math.max(160, cols * 7)
    const all = projects(snap, eff)
    const active = all.filter(one => !one.isIdle)
    const idle = all.filter(one => one.isIdle)
    const mine = here.config.project
    const open =
      ui.open ??
      (active.some(one => one.project === mine) ? mine : undefined) ??
      active.find(one => one.live.length > 0)?.project ??
      active[0]?.project
    const set = (change: (one: View) => View) => void update($, view, change)
    const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter(one => one !== id) : [...list, id])
    const down = snap.hosts.filter(host => !host.isOk)
    const live = all.reduce((n, one) => n + one.live.length, 0)
    const gpuCount = snap.hosts.reduce((n, host) => n + (host.gpus?.length ?? 0), 0)
    const busy = snap.hosts.reduce((n, host) => n + (host.gpus?.filter(gpu => gpu.util >= 10).length ?? 0), 0)
    // A run that names no machine of its own is shown by the machine it was read on.
    const machine = new Map(snap.hosts.flatMap(host => [host.host, ...(host.aliases ?? [])].map(alias => [alias, host.hostname ?? host.host] as const)))
    const hostOf = (run: Run) => (run.host === run.where ? machine.get(run.where) ?? run.host : run.host)

    const bar = (ratio: number, width: number, hue: string, theme: string) => {
      if (Svg) return <Svg source={svgBar(ratio, width, hue)} alt={pct(ratio)} width={width} height={4} />
      const [full, empty] = lineBar(ratio, Math.max(4, cols - 2))
      return (
        <Text>
          <Text color={theme}>{full}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
      )
    }

    const tab = (id: View['tab'], label: string, count: string) => (
      <Button key={`tab-${id}`} plain onPress={() => set(one => ({ ...one, tab: id }))}>
        <Text bold={ui.tab === id} dimColor={ui.tab !== id} underline={ui.tab === id}>
          {label}
        </Text>
        <Text dimColor> {count}</Text>
      </Button>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" gap={2}>
          {tab('exp', '实验', `${live} 运行`)}
          {tab('srv', '服务器', gpuCount ? `${busy}/${gpuCount} 卡忙` : `${snap.hosts.length} 台`)}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>{snap.isFetching ? '同步中…' : snap.fetchedAt ? clock(snap.fetchedAt) : ''}</Text>
          <Button key="refresh" hotkey="r" plain onPress={() => void refresh($, opts)}>
            <Text dimColor>⟳</Text>
          </Button>
        </Box>
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
        {ui.tab === 'exp' && down.length > 0 && (
          <Button key="down" plain onPress={() => set(one => ({ ...one, tab: 'srv' }))}>
            <Text color="warning">⚠ {down.map(host => host.host).join('、')} 连不上</Text>
            <Text dimColor> · 看服务器</Text>
          </Button>
        )}
      </Box>
    )

    const runRow = (run: Run) => {
      const stale = isStale(run, snap.fetchedAt, eff)
      const ratio = runRatio(run) ?? 0
      const hue = stale ? HUE.stale : HUE.running
      const trend = Svg && run.spark ? spark(run.spark, 52, 14, hue) : undefined
      const hint = stale ? `停滞 ${span(snap.fetchedAt - (run.updated ?? snap.fetchedAt))}` : leftText(run, now)
      return (
        <Box key={`run-${runKey(run)}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate">
                {run.name} <Text dimColor>{hostOf(run)}</Text>
              </Text>
            </Box>
            <Text>
              {run.total && run.step !== undefined ? <Text bold>{pct(ratio)}</Text> : ''}
              {hint && (
                <Text color={stale ? 'warning' : undefined} dimColor={!stale}>
                  {'  '}
                  {hint}
                </Text>
              )}
            </Text>
          </Box>
          {run.total && run.step !== undefined ? (
            <Box flexDirection="row" gap={1} alignItems="center">
              {bar(ratio, trend ? px - 60 : px, hue, stale ? 'warning' : 'suggestion')}
              {Svg && trend && <Svg source={trend} alt={`${run.sparkName ?? ''} 走势`} width={52} height={14} />}
            </Box>
          ) : (
            <Text dimColor>{run.started !== undefined ? `进度未上报 · 已运行 ${span(now - run.started)}` : '进度未上报'}</Text>
          )}
        </Box>
      )
    }

    const detailRow = (one: ProjectView, run: Run) => {
      const lost = isLost(run, snap.fetchedAt, eff)
      const kind = lost ? 'lost' : run.status
      const stage = one.digest?.short?.[run.stage] ?? one.stages.find(s => s.id === run.stage)?.title ?? run.stage
      const took = run.started !== undefined ? (run.finished ?? run.updated ?? run.started) - run.started : undefined
      const first = Object.entries(run.metrics ?? {})[0]
      const result = first ? `${first[0]} ${typeof first[1] === 'number' ? Number(first[1].toPrecision(4)) : first[1]}` : ''
      const when = lost
        ? `失联 ${span(snap.fetchedAt - (run.updated ?? snap.fetchedAt))}`
        : run.status === 'queued'
          ? '排队中'
          : took !== undefined && took > 0
            ? `用时 ${span(took)}`
            : ''
      return (
        <Box key={`row-${runKey(run)}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate">
                <Text color={COLOR[kind]}>{ICON[kind]}</Text> {run.name}
              </Text>
            </Box>
            <Box flexDirection="row" gap={1}>
              {result && <Text dimColor>{result}</Text>}
              {run.file && (run.status !== 'running' || lost) ? (
                <Button key={`rm-${runKey(run)}`} plain onPress={() => void archive($, opts, [run])}>
                  <Text dimColor>✕</Text>
                </Button>
              ) : null}
            </Box>
          </Box>
          <Text dimColor wrap="truncate">
            {'  '}
            {[stage, hostOf(run), when].filter(Boolean).join(' · ')}
          </Text>
          {run.note && (run.status === 'failed' || run.status === 'killed') && (
            <Text color="error" wrap="truncate">
              {'  '}
              {run.note}
            </Text>
          )}
        </Box>
      )
    }

    const card = (one: ProjectView) => {
      const doneStages = one.stages.filter(stage => stage.status === 'done').length
      const count = (status: RunStatus) => one.ended.filter(run => run.status === status).length
      const kinds = [
        { n: count('done'), label: '完成', color: HUE.done, theme: 'success' },
        { n: count('failed'), label: '失败', color: HUE.failed, theme: 'error' },
        { n: count('killed'), label: '中止', color: HUE.stale, theme: 'warning' },
        { n: one.lost.length, label: '失联', color: HUE.stale, theme: 'warning' },
        { n: one.queued.length, label: '排队', color: HUE.label, theme: 'subtle' },
      ].filter(kind => kind.n > 0)
      const badge = Svg && kinds.length ? pills(kinds.map(kind => ({ count: kind.n, label: kind.label, color: kind.color }))) : undefined
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
      const shownLive = showAll ? one.live : one.live.slice(0, 4)
      const doing = one.digest?.now ? `正在 · ${one.digest.now}` : one.current ? `当前 · ${one.current.title}` : ''
      const nextLine = one.digest?.next ? `下一步 · ${one.digest.next}` : one.current?.goal ?? ''
      const room = Math.max(3, Math.min(7, Math.floor(px / 62)))

      return (
        <Box key={`card-${one.project}`} flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg && <Svg source={ring(one.ratio, 34, HUE.accent)} alt={`总进度 ${pct(one.ratio)}`} width={34} height={34} />}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate">
                {one.title}
                {!Svg && <Text dimColor> · {pct(one.ratio)}</Text>}
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
          {Svg ? (
            <Svg
              source={stepper(windowSteps(one, room), px)}
              alt={one.stages.map(stage => `${stage.status === 'done' ? '✔' : stage.id === one.current?.id ? '●' : '○'}${stage.title}`).join(' ')}
              width={px}
              height={42}
            />
          ) : (
            <Text dimColor wrap="wrap">
              阶段 {doneStages}/{one.stages.length} · {windowSteps(one, 5).map(step => `${step.status === 'done' ? '✔' : step.isCurrent ? '●' : '○'}${step.title}`).join(' ')}
            </Text>
          )}
          {nextLine && (
            <Text dimColor wrap="truncate">
              {nextLine}
            </Text>
          )}
          {one.live.length > 0 && (
            <Box flexDirection="column" gap={1}>
              {shownLive.map(runRow)}
              {one.live.length > 4 && (
                <Button key={`more-${one.project}`} plain onPress={() => set(v => ({ ...v, more: toggleIn(v.more, one.project) }))}>
                  <Text dimColor>{showAll ? '收起' : `还有 ${one.live.length - 4} 个运行中 ▾`}</Text>
                </Button>
              )}
            </Box>
          )}
          {(kinds.length > 0 || one.plan) && (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              {Svg && badge ? (
                <Svg source={badge.source} alt={kinds.map(kind => `${kind.n} ${kind.label}`).join(' · ')} width={badge.width} height={badge.height} />
              ) : (
                <Text>
                  {kinds.map((kind, i) => (
                    <Text>
                      {i > 0 ? '  ' : ''}
                      <Text color={kind.theme}>{kind.n}</Text>
                      <Text dimColor> {kind.label}</Text>
                    </Text>
                  ))}
                </Text>
              )}
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
            <Box flexDirection="column" gap={1}>
              <Text dimColor wrap="wrap">
                清理和归档都只是把状态文件移到 {eff.statusDir}/archive/日期/，随时可以找回。
              </Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {clearable.length > 0 &&
                  (ui.confirm === `clear:${one.project}` ? (
                    <Button key={`clear-${one.project}`} label={`确认清理 ${clearable.length} 个`} variant="primary" onPress={() => void archive($, opts, clearable)} />
                  ) : (
                    <Button key={`clear-${one.project}`} label={`清理已结束 ${clearable.length}`} onPress={() => set(v => ({ ...v, confirm: `clear:${one.project}` }))} />
                  ))}
                {ui.confirm === `archive:${one.project}` ? (
                  <Button key={`archive-${one.project}`} label={`确认归档整个项目（${one.runs.length + 1} 个文件）`} variant="primary" onPress={() => void archive($, opts, one.runs, one)} />
                ) : (
                  <Button key={`archive-${one.project}`} label="归档整个项目" onPress={() => set(v => ({ ...v, confirm: `archive:${one.project}` }))} />
                )}
                <Button key={`cancel-${one.project}`} label="取消" role="dismiss" onPress={() => set(v => ({ ...v, manage: undefined, confirm: undefined }))} />
              </Box>
            </Box>
          )}
          {isDetail && (
            <Box flexDirection="column" gap={1}>
              {listed.slice(0, 15).map(run => detailRow(one, run))}
              {listed.length > 15 && <Text dimColor>…共 {listed.length} 个，较早的可在“管理”里一并清理</Text>}
            </Box>
          )}
        </Box>
      )
    }

    const row = (one: ProjectView) => {
      const lefts = one.live.map(run => eta(run, now)).filter((t): t is number => t !== undefined)
      const state = one.live.length
        ? `${one.live.length} 运行${lefts.length ? ` · 剩 ${span(Math.min(...lefts))}` : ''}`
        : one.queued.length
          ? `${one.queued.length} 排队`
          : one.plan?.status === 'done'
            ? '已完成'
            : one.plan?.status === 'failed'
              ? '已终止'
              : '无运行'
      return (
        <Box key={`row-${one.project}`} flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg source={ring(one.ratio, 16, one.live.length ? HUE.accent : HUE.label, false)} alt={pct(one.ratio)} width={16} height={16} />
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

    const experiments = (
      <Box flexDirection="column" gap={1}>
        {snap.fetchedAt > 0 && all.length === 0 && <Text dimColor>还没有实验上报状态。</Text>}
        {active.map(one => (one.project === open ? card(one) : row(one)))}
        {idle.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Button key="idle" plain onPress={() => set(v => ({ ...v, showIdle: !v.showIdle }))}>
              <Text dimColor>
                {ui.showIdle ? '▾' : '▸'} 闲置 {idle.length} 个项目
              </Text>
            </Button>
            {ui.showIdle && idle.map(one => (one.project === open ? card(one) : row(one)))}
          </Box>
        )}
      </Box>
    )

    const servers = (
      <Box flexDirection="column" gap={1}>
        {snap.hosts.length === 0 && <Text dimColor>还没有服务器信息，按 ⟳ 同步。</Text>}
        {snap.hosts.map(host => {
          const load = host.load !== undefined && host.cpus ? `CPU ${Math.round((host.load / host.cpus) * 100)}%` : ''
          const mem = host.memAvail !== undefined ? `${gb(host.memAvail)} 内存空闲` : ''
          const list = host.gpus ?? []
          return (
            <Box key={`host-${host.host}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Box flexShrink={1}>
                  <Text wrap="truncate">
                    <Text color={host.isOk ? 'success' : 'warning'}>●</Text> <Text bold>{host.hostname ?? host.host}</Text>
                    <Text dimColor> {[host.host, ...(host.aliases ?? [])].filter(name => name !== host.hostname).join(' / ')}</Text>
                  </Text>
                </Box>
                <Text dimColor>{[load, mem].filter(Boolean).join(' · ')}</Text>
              </Box>
              {!host.isOk && (
                <Text color="warning" wrap="truncate">
                  连不上：{host.error}
                </Text>
              )}
              {list.length > 0 &&
                (Svg ? (
                  <Svg
                    source={svgGpus(list, px).source}
                    alt={list.map(gpu => `GPU${gpu.index} ${gpu.util}% ${gb(gpu.memUsed)}/${gb(gpu.memTotal)} ${gpu.users.join(',') || '空闲'}`).join('；')}
                    width={px}
                    height={svgGpus(list, px).height}
                  />
                ) : (
                  list.map(gpu => (
                    <Text wrap="truncate">
                      <Text dimColor>{gpu.index} </Text>
                      <Text color={gpu.util >= 60 ? 'suggestion' : 'subtle'}>{lineBar(gpu.util / 100, 8)[0]}</Text>
                      <Text dimColor>{lineBar(gpu.util / 100, 8)[1]}</Text> {gpu.util}%
                      <Text dimColor>
                        {' '}
                        {gb(gpu.memUsed)}/{gb(gpu.memTotal)} · {gpu.users.join(',') || '空闲'}
                      </Text>
                    </Text>
                  ))
                ))}
              {host.isOk && list.length === 0 && <Text dimColor>没有 GPU 或读不到 nvidia-smi</Text>}
            </Box>
          )
        })}
        {gpuCount > 0 && <Text dimColor>每行：卡号 · 利用率 · 显存 · 占用者</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notices}
        {ui.tab === 'exp' ? experiments : servers}
      </Box>
    )
  })
}

