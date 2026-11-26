import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { estimate, eta, parse, readOptions, span, windowSteps, projects } from './data'
import { clusterRuns, gpuCount, parseSlurm, projectOfDir, slurmSeconds } from './slurm'

const PANE = {
  plugin: 'exp-monitor',
  component: 'Pane',
  requestId: 'exp-monitor',
  props: {
    title: '实验进度',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'exp-monitor',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const now = Math.floor(Date.now() / 1000)
const DIR = '/home/me/.exp_status'
const line = (value: object) => JSON.stringify(value)
const STDOUT = [
  '@@HOST local',
  `@@FILE ${DIR}/tta.plan.json`,
  '{',
  '  "kind": "plan", "project": "tta", "title": "TTA 崩塌机理", "updated": 1,',
  '  "stages": [{"id": "probe", "title": "入口探针"}, {"id": "gate", "title": "Gate 验证", "goal": "主结论在 C10-C 上成立"}, {"id": "full", "title": "全量"}]',
  '}',
  `@@FILE ${DIR}/tta--s1.json`,
  line({ id: 's1', project: 'tta', stage: 'probe', name: 'probe-a', status: 'done', started: now - 7200, finished: now - 300, metrics: { acc: 0.81 } }),
  `@@FILE ${DIR}/old.plan.json`,
  line({ kind: 'plan', project: 'old', title: '旧项目', status: 'done', updated: now - 30 * 86400, stages: [{ id: 'a', title: 'A', status: 'done' }] }),
  '@@SYS hub 64 32.5 257000 160000',
  '@@GPU',
  '0, GPU-a, NVIDIA A100 80GB PCIe, 100, 9022, 81920',
  '1, GPU-b, NVIDIA A100 80GB PCIe, 0, 4, 81920',
  '@@APPS',
  'GPU-a,9000,alice',
  '@@HOST gpu1',
  `@@FILE ${DIR}/tta--g1.json`,
  line({ id: 'g1', project: 'tta', stage: 'gate', name: 'lr3e-4', status: 'running', step: 500, total: 1000, started: now - 1000, updated: now - 10, metrics: { loss: 0.3412 } }),
  `@@FILE ${DIR}/tta--g2.json`,
  line({ id: 'g2', project: 'tta', stage: 'gate', name: 'lr1e-3', status: 'failed', note: 'OOM' }),
  `@@FILE ${DIR}/tta--z.json`,
  line({ id: 'z', project: 'tta', stage: 'gate', name: 'zombie', status: 'running', step: 10, total: 100, started: now - 30 * 3600, updated: now - 20 * 3600 }),
  '@@SYS box17 144 26 515000 448000',
  '@@HOST gpu1b',
  `@@FILE ${DIR}/tta--g1.json`,
  line({ id: 'g1', project: 'tta', stage: 'gate', name: 'lr3e-4', status: 'running', step: 500, total: 1000, started: now - 1000, updated: now - 10 }),
  '@@SYS box17 144 26 515000 448000',
  '@@HOST gpu2',
  'ssh: connect to host gpu2 port 22: Connection refused',
  '@@ERR',
  '@@HUB',
  '@@ROOT /home/me/research/tta',
  '{"project": "tta", "title": "TTA 崩塌机理"}',
  '@@SIG abc123',
  '11-21 GATE-A: receipt; P1 met on seeds 1-3',
  '@@END',
  '',
].join('\n')

const WORKERS = { workers: 'local,gpu1,gpu1b,gpu2', clusters: '' }

// The engine beneath the plugin, as each test needs it: a store in memory, the
// hub's answer, and whatever a test adds.
function world(on: any, extra: { stdin?: (text: string) => void; model?: string; opened?: string[]; stdout?: string } = {}) {
  const stored = new Map<string, unknown>()
  // Two fetches ago, 40 minutes back, the running run stood at step 300.
  stored.set('history', { 'gpu1|tta|g1': [[now - 2410, 300]] })
  on('command.register', () => ({ value: { command: 'exp' } }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    extra.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // A refused period never runs: timers stay quiet, as in a session's first half hour.
  on('clock.every', () => ({ deny: 'no timers in tests' }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: stored.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', () => ({ value: line({ project: 'tta', title: 'TTA 崩塌机理', workers: ['local', 'gpu1', 'gpu1b', 'gpu2'] }) }))
  on('process.run', (_: unknown, e: { init?: { stdin?: string } }) => {
    const stdin = e.init?.stdin ?? ''
    extra.stdin?.(stdin)
    const isFetch = stdin.includes('@@HUB')
    return { value: { exitCode: 0, stdout: isFetch ? extra.stdout ?? STDOUT : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => ({
    value: extra.model
      ? { isAnswered: true, text: extra.model, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      : { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  return stored
}

const status = (text: string) => ({
  command: 'exp-status',
  args: text,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 80 },
})

test('the open project shows its stages, its running run with a trend estimate, and folds the rest', { options: WORKERS }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /TTA 崩塌机理/ }))?.text).toContain('TTA 崩塌机理')
    // 200 steps in 40 minutes leaves 500 steps: about an hour and a half.
    expect((await ui.find({ type: 'Text', text: /剩/ }))?.text).toContain('剩 ~1.5h')
    // The run read through two aliases of one machine is drawn once.
    expect((await ui.findAll({ type: 'Text', text: /^lr3e-4/ })).length).toBe(1)
    // A run silent for 20 hours is lost, not running.
    expect(await ui.find({ type: 'Text', text: /^zombie/ })).toBeUndefined()
    if (surface !== 'terminal') {
      const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
      expect(alts).toContain('1 完成 · 1 失败 · 1 失联')
      expect(alts).toContain('✔入口探针 ●Gate 验证 ○全量')
    }
    // The finished project waits folded under the idle group.
    expect((await ui.find({ type: 'Text', text: /闲置/ }))?.text).toContain('闲置 1 个项目')
    expect((await ui.find({ type: 'Text', text: /gpu2 连不上/ }))?.text).toContain('gpu2')
    await ui.press({ key: 'detail-tta' })
    expect((await ui.find({ type: 'Text', text: /^\s*OOM$/ }))?.text?.trim()).toBe('OOM')
    expect((await ui.find({ type: 'Text', text: /失联 ~/ }))?.text).toContain('失联 ~')
    await ui.press({ key: 'detail-tta' })
    await ui.unmount()
  }
})

test('the server tab shows each machine once with its GPUs', { options: WORKERS }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-srv' })
  expect((await ui.find({ type: 'Text', text: /box17/ }))?.text).toContain('gpu1 / gpu1b')
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  expect(alts).toContain('0 100% 9G/80G alice；1 0% 0G/80G 空闲')
  expect((await ui.find({ type: 'Text', text: /连不上/ }))?.text).toContain('Connection refused')
  await ui.press({ key: 'tab-exp' })
  await ui.unmount()
})

test('clearing moves the ended files into the archive, after a second press', { options: WORKERS }, async ($, on) => {
  const scripts: string[] = []
  const stored = world(on, { stdin: text => scripts.push(text) })
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'manage-tta' })
  await ui.press({ key: 'clear-tta' })
  expect(scripts.some(text => text.includes('EXP_MOVE'))).toBe(false)
  expect((await ui.find({ type: 'Button', key: 'clear-tta' }))?.props.label).toBe('确认清理 3 个')
  await ui.press({ key: 'clear-tta' })
  const moved = scripts.filter(text => text.includes('EXP_MOVE')).join('\n')
  expect(moved).toContain(`mv -f -- ${DIR}/tta--s1.json`)
  expect(moved).toContain('ssh -o BatchMode=yes -o ConnectTimeout=6 gpu1 sh -s')
  expect(moved).toContain('/archive/$(date +%Y%m%d)')
  expect(Object.keys(stored.get('dismissed') as object)).toContain(`gpu1|${DIR}/tta--g2.json`)
  // The next fetch reads the same files back from a writer and keeps them hidden.
  await $.command.run(status(''))
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  expect(alts.some(alt => String(alt).includes('完成'))).toBe(false)
  await ui.unmount()
})

test('a project summary comes from its latest records, once per change', { options: WORKERS }, async ($, on) => {
  const stored = world(on, { model: '好的：{"now": "GATE-A 收尾", "next": "开 FULL-1", "short": {"probe": "探针"}}' })
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))
  await $.command.run(status(''))
  // Keyed by the records and the runs that run now: either changing asks again.
  expect((stored.get('digest:tta') as { sig: string }).sig).toBe('abc123#g1')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /正在/ }))?.text).toBe('正在 · GATE-A 收尾')
  expect((await ui.find({ type: 'Text', text: /下一步/ }))?.text).toBe('下一步 · 开 FULL-1')
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  expect(alts.some(alt => String(alt).includes('✔入口探针'))).toBe(true)
  await ui.unmount()
})

test('in an initialized project the band shows its progress and a button that opens the pane', { options: WORKERS }, async ($, on) => {
  const opened: string[] = []
  world(on, { opened })
  on('prompt.submit', () => {
    throw new Error('an initialized project is not initialized again')
  })
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: false })
  await $.command.run(status(''))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /TTA 崩塌机理/ }))?.text).toContain('Gate 验证')
  expect((await ui.find({ type: 'Text', text: /运行中/ }))?.text).toContain('1 运行中 · 剩 ~1.5h')
  opened.length = 0
  await ui.press({ key: 'exp-open' })
  expect(opened).toEqual(['exp-monitor'])
  await ui.unmount()
})

const run = (over: Partial<Run>): Run => ({
  id: 'r', project: 'p', stage: 's', name: 'r', host: 'h', where: 'h', status: 'running', total: 10000, ...over,
})

test('estimates: the trend wins, a mid-training registration has none, a restart starts over', () => {
  const t = 1_000_000
  // Registered mid-training: started and updated the same moment, already at 36000.
  const late = run({ step: 36000, total: 50000, started: t, updated: t })
  expect(estimate([late], {}, t).runs[0]!.estRate).toBeUndefined()
  // Half an hour later at 37800: one step a second from the trend.
  const seen = estimate([late], {}, t).history
  const later = estimate([{ ...late, step: 37800, updated: t + 1800 }], seen, t + 1800).runs[0]!
  expect(later.estFrom).toBe('trend')
  expect(later.estRate).toBe(1)
  expect(eta(later, t + 1800)).toBe(12200)
  // The job's own rate stands in until there is a trend.
  expect(estimate([run({ step: 10, rate: 2, started: t, updated: t })], {}, t).runs[0]!.estFrom).toBe('job')
  // A step that went back is a restart: the old points are dropped.
  const back = estimate([run({ step: 100, updated: t + 3600 })], { 'h|p|r': [[t, 5000]] }, t + 3600)
  expect(back.history['h|p|r']).toEqual([[t + 3600, 100]])
})

test('nineteen stages fold to the finished count, the current one and what follows', () => {
  const opts = readOptions({})
  const stages = Array.from({ length: 19 }, (_, i) => ({ id: `s${i}`, title: `阶段${i}`, status: i < 11 ? ('done' as const) : undefined }))
  const snap = {
    runs: [],
    plans: [{ project: 'd', title: 'D', stages, current: 's11', updated: 1, where: 'local' }],
    hosts: [],
    digests: {},
    fetchedAt: 1,
    isFetching: false,
  }
  const steps = windowSteps(projects(snap, opts)[0]!, 6)
  expect(steps.map(step => step.title)).toEqual(['已完成 11', '阶段11', '阶段12', '阶段13', '阶段14', '还有 4'])
  expect(steps[0]!.group).toBe(11)
})

test('the hub output parses machines, GPUs and project records', () => {
  const parsed = parse(STDOUT)
  expect(parsed.hosts.map(host => host.hostname)).toEqual(['hub', 'box17', 'box17', undefined])
  expect(parsed.hosts[0]!.gpus![0]).toEqual({ index: 0, name: 'A100 80GB PCIe', util: 100, memUsed: 9022, memTotal: 81920, users: ['alice'] })
  expect(parsed.notes).toEqual([{ project: 'tta', root: '/home/me/research/tta', sig: 'abc123', text: '11-21 GATE-A: receipt; P1 met on seeds 1-3' }])
  expect(parsed.runs.find(one => one.id === 's1')!.file).toBe(`${DIR}/tta--s1.json`)
})

test('a project opened for the first time asks cc to initialize it, once', { options: { autoInit: true } }, async ($, on) => {
  const prompts: string[] = []
  const stored = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'exp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('clock.every', () => ({ value: undefined }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('fs.list', () => ({
    value: [
      { name: 'README.md', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
      { name: 'train.py', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
    ],
  }))

  await $.session.start({ cwd: '/home/me/newproj', surface: null, isInteractive: false })
  expect(prompts.length).toBe(0)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('exp-monitor 初始化')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:2' })
  expect(prompts.length).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /初始化中/ }))?.text).toBe('实验监控初始化中…')
  await ui.unmount()
})

test('a folder holding nothing a project holds is not initialized unasked', async ($, on) => {
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'exp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [{ name: 'notes.txt', kind: 'file', size: 3, mtimeMs: 0, isLink: false }] }))
  on('store.get', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('clock.every', () => ({ value: undefined }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))

  await $.session.start({ cwd: '/Users/me/scratch/empty', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(prompts.length).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /未初始化/ }))?.text).toBe('本项目未初始化实验监控')
  await ui.unmount()
})

test('durations are told in half hours', () => {
  expect(span(0)).toBe('<30min')
  expect(span(29 * 60)).toBe('<30min')
  expect(span(40 * 60)).toBe('~1h')
  expect(span(80 * 60)).toBe('~1.5h')
  expect(span(5 * 3600 + 10 * 60)).toBe('~5h')
  expect(span(26 * 3600)).toBe('~1d')
  expect(span(40 * 3600)).toBe('~1.5d')
})

test('with auto initialization off a new project only offers the button', { options: { autoInit: false } }, async ($, on) => {
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'exp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [{ name: '.git', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('store.get', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('clock.every', () => ({ value: undefined }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))

  await $.session.start({ cwd: '/home/me/research/proj', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(prompts.length).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'exp-init' }))?.props.label).toBe('初始化')
  await ui.unmount()
})

// A Slurm login node's answer, spliced in before the hub's own records.
const CLUSTER = [
  '@@CLUSTER gpuc',
  '@@FILE /home/u/.exp_status/tta--c1.json',
  line({ id: 'c1', project: 'tta', stage: 'gate', name: 'c1', status: 'running', step: 100, total: 1000, started: now - 3000, updated: now - 60, slurmJob: '501', host: 'gpu1' }),
  '@@CNAME public_gpu',
  '@@NODES',
  'gpu1   gpu   mix    gpu:a800:8   gpu:a800:3(IDX:0-2)   24/40/0/64   1000   983040',
  'gpu1   other   mix    gpu:a800:8   gpu:a800:3(IDX:0-2)   24/40/0/64   1000   983040',
  'gpu2   gpu   idle   gpu:a800:8   gpu:a800:0(IDX:N/A)   0/64/0/64    0      983040',
  '@@PARTS',
  'gpu*|up|7-00:00:00|1/1/0/2',
  '@@QUEUE 5 2',
  '@@MINE',
  '501|c1|RUNNING|50:00|2-00:00:00|gpu1|None|gres:gpu:a800:1|gpu|2026-11-24T10:00:00|/home/u/research/tta',
  '502|ev_x|RUNNING|1:00:00|1-00:00:00|gpu1|None|gres:gpu:a800:2|gpu|2026-11-24T09:00:00|/home/u/old_tta_runs/x',
  '503|ev_y|PENDING|0:00|1-00:00:00||Priority|gres:gpu:a800:1|gpu|2026-11-25T03:00:00|/home/u/old_tta_runs/y',
  '@@RECENT',
  '499|ev_x|FAILED|00:01:36|2-00:00:00|gpu2|gpu|2026-11-24T08:00:00|2026-11-24T08:01:36|/home/u|1:0|billing=8,gres/gpu=1',
  '500|bash|COMPLETED|00:00:42|00:05:00|gpu2|gpu|2026-11-24T07:00:00|2026-11-24T07:00:42|/home/u|0:0|billing=4,gres/gpu=1',
  '@@SHARE 0.0083',
  '@@JOBGPU',
  '501, 97, 10395, 81920',
  '502, 0, 14277, 81920',
  '502, 3, 100, 81920',
].join('\n')
const WITH_CLUSTER = STDOUT.replace('@@HUB', `${CLUSTER}\n@@HUB`)
const CLUSTERS = { workers: 'local,gpu1,gpu1b,gpu2', clusters: 'gpuc' }

test('slurm durations, GPU counts and job folders read right', () => {
  expect(slurmSeconds('2-00:00:00')).toBe(172800)
  expect(slurmSeconds('12:04:17')).toBe(43457)
  expect(slurmSeconds('23:03')).toBe(1383)
  expect(slurmSeconds('UNLIMITED')).toBeUndefined()
  expect(gpuCount('gpu:a800:7(IDX:0,2-7)'.replace(/\(.*$/, ''))).toBe(7)
  expect(gpuCount('gres:gpu:a800:1')).toBe(1)
  expect(gpuCount('billing=8,cpu=8,gres/gpu=2,mem=48G')).toBe(2)
  const keys = [
    { project: 'memo', names: ['memo'] },
    { project: 'rewind', names: ['rewind', 'memorewind'] },
    { project: 'clockwork', names: ['clockwork'] },
  ]
  // The deepest folder that names a project wins.
  expect(projectOfDir('/home/u/my_memo/rewind_runs/probe', keys)).toBe('rewind')
  expect(projectOfDir('/home/u/research/clock-work', keys)).toBe('clockwork')
  expect(projectOfDir('/home/u', keys)).toBeUndefined()
})

test('cluster jobs join their projects: reported, found by folder, by name, or left unsorted', () => {
  const parsed = parse(WITH_CLUSTER)
  const host = parsed.hosts.find(one => one.host === 'gpuc')!
  expect(host.cluster!.name).toBe('public_gpu')
  expect(host.cluster!.nodes.map(node => `${node.name}:${node.gpusUsed}/${node.gpus}`)).toEqual(['gpu1:3/8', 'gpu2:0/8'])
  expect(host.cluster!.partitions[0]).toEqual({ name: 'gpu', isUp: true, limit: 604800, allocated: 1, idle: 1, other: 0, total: 2 })
  expect([host.cluster!.running, host.cluster!.pending, host.cluster!.fairShare]).toEqual([5, 2, 0.0083])
  const joined = clusterRuns(parsed.runs, parsed.plans, [{ where: 'gpuc', cluster: host.cluster! }], parsed.notes, now)
  const of = (name: string) => joined.runs.filter(run => run.where === 'gpuc' && run.name === name)
  // The job that reports is one run, with the scheduler's facts on it.
  expect(of('c1').length).toBe(1)
  expect(of('c1')[0]!.slurm!.limit).toBe(172800)
  expect(of('c1')[0]!.step).toBe(100)
  // tta_runs names the project tta; the failed ev_x from home follows its namesake.
  expect(of('ev_x').map(run => `${run.project}:${run.status}`)).toEqual(['tta:running', 'tta:failed'])
  expect(of('ev_y')[0]!.status).toBe('queued')
  expect(of('ev_y')[0]!.slurm!.reason).toBe('Priority')
  expect(of('bash')[0]!.project).toBe('cluster:gpuc')
  // Each running job's GPUs, as the job itself sees them.
  expect(host.cluster!.mine.find(job => job.id === '502')!.usage).toEqual([
    { util: 0, memUsed: 14277, memTotal: 81920 },
    { util: 3, memUsed: 100, memTotal: 81920 },
  ])
  expect(joined.plans.find(plan => plan.project === 'cluster:gpuc')!.title).toBe('public_gpu · 未归类作业')
})

test('a cluster is drawn like a machine: its jobs as runs, its GPUs with their load and time left', { options: CLUSTERS }, async ($, on) => {
  world(on, { stdout: WITH_CLUSTER })
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // In the project, a cluster job reads as a run on a machine: its node, its progress.
    expect((await ui.find({ type: 'Text', text: /^c1/ }))?.text).toBe('c1 gpu1')
    expect((await ui.find({ type: 'Text', text: /^ev_x/ }))?.text).toBe('ev_x gpu1')
    expect(await ui.find({ type: 'Text', text: /时限剩/ })).toBeUndefined()
    await ui.press({ key: 'detail-tta' })
    expect((await ui.find({ type: 'Text', text: /Priority/ }))?.text).toContain('排队中 · Priority · 预计 11-25 03:00')
    expect((await ui.find({ type: 'Text', text: /FAILED/ }))?.text?.trim()).toBe('FAILED · exit 1:0')
    await ui.press({ key: 'detail-tta' })
    await ui.press({ key: 'tab-srv' })
    expect((await ui.find({ type: 'Text', text: /public_gpu/ }))?.text).toBe('● public_gpu gpuc')
    expect((await ui.find({ type: 'Text', text: /GPU 3\/16/ }))?.text).toBe('CPU 19% · GPU 3/16 已分配')
    expect((await ui.find({ type: 'Text', text: /^排队 1/ }))?.text).toBe('排队 1：ev_y（Priority · 预计 11-25 03:00） · 公平份额 0.008')
    expect((await ui.find({ type: 'Text', text: /其余/ }))?.text).toBe('其余 0 卡被他人占用 · 13 卡空闲 · 排队 2')
    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)).toContain(
        'gpu1 97% 10G/80G c1 · 时限剩 ~2d；gpu1 0% 14G/80G ev_x · 时限剩 ~23h · 空转；gpu1 3% 0G/80G ev_x · 时限剩 ~23h · 空转',
      )
    } else {
      expect((await ui.find({ type: 'Text', text: /c1 · 时限剩/ }))?.text).toContain('97%')
    }
    await ui.press({ key: 'tab-exp' })
    await ui.unmount()
  }
})

test('a sidecar file on another machine that names the job id is the same run, not a second one', () => {
  const sidecar = [
    '@@HOST local',
    '@@FILE /home/me/.exp_status/tta--x-sidecar.json',
    line({ id: 'x-sidecar', project: 'tta', stage: 'gate', name: 'x via sidecar', status: 'running', step: 40, total: 100, started: now - 3600, updated: now - 60, slurmJob: '502' }),
  ].join('\n')
  const parsed = parse(WITH_CLUSTER.replace('@@HUB', `${sidecar}\n@@HUB`))
  const host = parsed.hosts.find(one => one.host === 'gpuc')!
  const joined = clusterRuns(parsed.runs, parsed.plans, [{ where: 'gpuc', cluster: host.cluster! }], parsed.notes, now)
  const job502 = joined.runs.filter(run => run.slurm?.id === '502')
  expect(job502.length).toBe(1)
  expect(job502[0]!.name).toBe('x via sidecar')
  expect(job502[0]!.step).toBe(40)
  expect(job502[0]!.slurm!.node).toBe('gpu1')
  // The job's own file wins over a sidecar's: c1 (501) stays the cluster's copy.
  const twice = parse(
    WITH_CLUSTER.replace('@@HUB', `@@HOST local\n@@FILE /h/tta--c1-side.json\n${line({ id: 'c1-side', project: 'tta', stage: 'gate', status: 'running', slurmJob: '501' })}\n@@HUB`),
  )
  const both = clusterRuns(twice.runs, twice.plans, [{ where: 'gpuc', cluster: twice.hosts.find(one => one.host === 'gpuc')!.cluster! }], twice.notes, now)
  expect(both.runs.filter(run => run.slurm?.id === '501').map(run => `${run.where}:${run.id}`)).toEqual(['gpuc:c1'])
})

test('every session reads every project machine: one a project names is fetched at once', { options: { workers: 'local', clusters: '' } }, async ($, on) => {
  const scripts: string[] = []
  const named = STDOUT.replace('{"project": "tta", "title": "TTA 崩塌机理"}', '{"project": "tta", "title": "TTA 崩塌机理", "workers": ["local", "gpu9"], "clusters": ["gpuc"]}')
  const stored = world(on, { stdin: text => scripts.push(text), stdout: named })
  await $.session.start({ cwd: '/home/me/research/tta', surface: 'desktop', isInteractive: true })
  await $.command.run(status(''))
  const fetches = scripts.filter(text => text.includes('@@HUB'))
  expect(fetches.length).toBe(2)
  expect(fetches[0]).not.toContain('gpu9')
  expect(fetches[1]).toContain('for h in local gpu9;')
  expect(fetches[1]).toContain('for h in gpuc;')
  expect(stored.get('fleet')).toEqual({ workers: ['gpu9', 'local'], clusters: ['gpuc'] })
})

test('a new session draws the last fetch at once and leads with its own project', { options: WORKERS }, async ($, on) => {
  const fetched: string[] = []
  const stored = world(on, { stdin: text => fetched.push(text) })
  // Another session fetched a minute ago: its snapshot is shared.
  stored.set('snapshot', {
    runs: [{ id: 'o1', project: 'other', stage: 'a', name: 'other-run', host: 'h', where: 'h', status: 'running', step: 1, total: 9, updated: now - 60 }],
    plans: [
      { project: 'tta', title: 'TTA 崩塌机理', stages: [{ id: 'probe', title: '入口探针', status: 'done' }], status: 'done', updated: 1, where: 'local' },
      { project: 'other', title: '别的项目', stages: [{ id: 'a', title: 'A' }], updated: now, where: 'local' },
    ],
    hosts: [],
    digests: {},
    fetchedAt: now - 60,
    isFetching: false,
  })
  on('session.attach', (_: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/home/me/research/tta', surface: null, isInteractive: false })
  expect(['after start', fetched.filter(text => text.includes('@@HUB')).length]).toEqual(['after start', 0])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(['after attach', fetched.filter(text => text.includes('@@HUB')).length]).toEqual(['after attach', 0])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // tta is finished, yet as this session's project it leads, open, above the busier one.
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const at = (word: string) => texts.findIndex(text => text?.includes(word))
  expect(at('TTA 崩塌机理')).toBeGreaterThan(-1)
  expect(at('TTA 崩塌机理')).toBeLessThan(at('别的项目'))
  expect(await ui.find({ type: 'Button', key: 'close-tta' })).toBeTruthy()
  await ui.unmount()
})
