import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { estimate, eta, parse, readOptions, span, windowSteps, projects } from './data'

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

const WORKERS = { workers: 'local,gpu1,gpu1b,gpu2' }

// The engine beneath the plugin, as each test needs it: a store in memory, the
// hub's answer, and whatever a test adds.
function world(on: any, extra: { stdin?: (text: string) => void; model?: string; opened?: string[] } = {}) {
  const stored = new Map<string, unknown>()
  // Two fetches ago, 40 minutes back, the running run stood at step 300.
  stored.set('history', { 'gpu1|tta|g1': [[now - 2410, 300]] })
  on('command.register', () => ({ value: { command: 'exp' } }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    extra.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
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
    return { value: { exitCode: 0, stdout: isFetch ? STDOUT : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  expect(alts).toContain('GPU0 100% 9G/80G alice；GPU1 0% 0G/80G 空闲')
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
  expect((stored.get('digest:tta') as { sig: string }).sig).toBe('abc123')
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
