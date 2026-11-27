// Drawings for surfaces that take an Svg (the app, VS Code, a phone). Colors
// and the label gray are chosen to read on a light and a dark pane alike.

export type StepStatus = 'todo' | 'active' | 'done' | 'failed' | 'skipped'

export const HUE = {
  accent: '#d97757',
  running: '#3b82f6',
  stale: '#e0a526',
  done: '#22a06b',
  failed: '#e5534b',
  track: 'rgba(128,128,128,0.22)',
  label: '#8b8b8b',
}

const FONT = `-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif`
const clamp = (ratio: number) => Math.min(1, Math.max(0, ratio))
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

// About how wide a label draws: a CJK glyph a full em, the rest a little over half.
const textWidth = (text: string, size: number) =>
  [...text].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? size : size * 0.58), 0)
const fit = (text: string, size: number, room: number) => {
  if (textWidth(text, size) <= room) return text
  let cut = [...text]
  while (cut.length > 1 && textWidth(cut.join('') + '…', size) > room) cut = cut.slice(0, -1)
  return cut.join('') + '…'
}

/** A progress ring with the percentage in its middle. */
export function ring(ratio: number, size: number, color: string, showText = true) {
  const stroke = Math.max(2, size / 9)
  const r = (size - stroke) / 2
  const c = size / 2
  const length = 2 * Math.PI * r
  const shown = clamp(ratio)
  const text = showText
    ? `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="${(size * 0.28).toFixed(1)}" font-weight="600" fill="${HUE.label}">${Math.round(shown * 100)}%</text>`
    : ''
  return svg(
    size,
    size,
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${HUE.track}" stroke-width="${stroke}"/>` +
      (shown > 0
        ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(shown * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
        : '') +
      text,
  )
}

/** One thin rounded bar. */
export function bar(ratio: number, width: number, color: string, h = 4) {
  const r = h / 2
  const x = ratio > 0 ? Math.max(clamp(ratio) * width, h) : 0
  return svg(
    width,
    h,
    `<rect width="${width}" height="${h}" rx="${r}" fill="${HUE.track}"/>` +
      (x > 0 ? `<rect width="${x}" height="${h}" rx="${r}" fill="${color}"/>` : ''),
  )
}

/**
 * The stages as a pipeline: nodes joined by a line, the label under each. A
 * node with `group` stands for that many stages folded into one: finished ones
 * show their count, the ones still ahead a `+n`.
 */
export function stepper(
  steps: { title: string; status: StepStatus; ratio: number; isCurrent: boolean; group?: number }[],
  width: number,
) {
  const n = steps.length
  if (n === 0) return svg(width, 1, '')
  const node = 7
  const size = 11
  const h = 42
  const cy = node + 2
  const pad = Math.min(width / (2 * n), 44)
  const gap = n > 1 ? (width - 2 * pad) / (n - 1) : 0
  const xs = steps.map((_, i) => (n > 1 ? pad + i * gap : width / 2))
  const room = n > 1 ? gap - 6 : width
  const parts: string[] = []
  for (let i = 0; i + 1 < n; i++) {
    const isDone = steps[i]!.status === 'done' || steps[i]!.status === 'skipped'
    parts.push(
      `<line x1="${xs[i]! + node + 2}" y1="${cy}" x2="${xs[i + 1]! - node - 2}" y2="${cy}" stroke="${isDone ? HUE.done : HUE.track}" stroke-width="2" stroke-linecap="round"/>`,
    )
  }
  steps.forEach((step, i) => {
    const x = xs[i]!
    const count = (fill: string) =>
      `<text x="${x}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="8.5" font-weight="700" fill="${fill}">${step.group}</text>`
    if (step.group && step.status === 'done') {
      parts.push(`<circle cx="${x}" cy="${cy}" r="${node + 1}" fill="${HUE.done}"/>`, count('#fff'))
    } else if (step.group) {
      parts.push(
        `<circle cx="${x}" cy="${cy}" r="${node}" fill="none" stroke="${HUE.label}" stroke-opacity="0.55" stroke-width="1.4" stroke-dasharray="2.2 2"/>`,
        count(HUE.label),
      )
    } else if (step.status === 'done') {
      parts.push(
        `<circle cx="${x}" cy="${cy}" r="${node}" fill="${HUE.done}"/>`,
        `<path d="M${x - 3.2} ${cy + 0.2} l2.2 2.2 l4.2 -4.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    } else if (step.status === 'failed') {
      parts.push(
        `<circle cx="${x}" cy="${cy}" r="${node}" fill="${HUE.failed}"/>`,
        `<path d="M${x - 2.6} ${cy - 2.6} l5.2 5.2 M${x + 2.6} ${cy - 2.6} l-5.2 5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
      )
    } else if (step.status === 'active') {
      const r = node - 1
      const length = 2 * Math.PI * r
      parts.push(
        `<circle cx="${x}" cy="${cy}" r="${r}" fill="none" stroke="${HUE.track}" stroke-width="2"/>`,
        `<circle cx="${x}" cy="${cy}" r="${r}" fill="none" stroke="${HUE.running}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(Math.max(0.08, clamp(step.ratio)) * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 ${x} ${cy})"/>`,
        `<circle cx="${x}" cy="${cy}" r="2.4" fill="${HUE.running}"/>`,
      )
    } else {
      parts.push(
        `<circle cx="${x}" cy="${cy}" r="${node - 1}" fill="none" stroke="${HUE.label}" stroke-opacity="0.55" stroke-width="1.6"${step.status === 'skipped' ? ' stroke-dasharray="2 2"' : ''}/>`,
      )
    }
    const color = step.isCurrent ? HUE.running : HUE.label
    parts.push(
      `<text x="${x}" y="${h - 6}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${step.isCurrent ? 600 : 400}" fill="${color}">${esc(fit(step.title, size, room))}</text>`,
    )
  })
  return svg(width, h, parts.join(''))
}

/** A small line of recent values, the last one marked. */
export function spark(values: number[], width: number, h: number, color: string) {
  const points = values.filter(v => Number.isFinite(v))
  if (points.length < 2) return undefined
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const span = hi - lo || 1
  const step = (width - 4) / (points.length - 1)
  const xy = points.map((v, i) => [2 + i * step, 2 + (h - 4) * (1 - (v - lo) / span)] as const)
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const [lx, ly] = xy[xy.length - 1]!
  return svg(
    width,
    h,
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="1.8" fill="${color}"/>`,
  )
}

/** Soft tinted pills, one per count: a dot, the count in its color, the label gray. */
export function pills(items: { count: number; label: string; color: string }[], h = 20) {
  const size = 11.5
  const gap = 6
  let x = 0
  const parts: string[] = []
  for (const item of items) {
    const count = String(item.count)
    const w = 10 + 6 + 4 + textWidth(count, size) + 4 + textWidth(item.label, size) + 10
    const cy = h / 2
    parts.push(
      `<rect x="${x}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${item.color}" fill-opacity="0.13"/>`,
      `<circle cx="${x + 13}" cy="${cy}" r="3" fill="${item.color}"/>`,
      `<text x="${x + 20}" y="${cy}" dominant-baseline="central" font-family="${FONT}" font-size="${size}"><tspan font-weight="700" fill="${item.color}">${count}</tspan><tspan dx="4" fill="${HUE.label}">${esc(item.label)}</tspan></text>`,
    )
    x += w + gap
  }
  const width = Math.max(1, Math.ceil(x - gap))
  return { source: svg(width, h, parts.join('')), width, height: h }
}

/**
 * GPUs, a row each: a label (a machine's GPU index, or a cluster job's node),
 * a load bar, a memory bar and, at the right, load, memory in GB and a note
 * (who holds it; for a cluster job its name and time left), amber when
 * `warn` is set.
 */
export function gpus(
  list: { label: string; util: number; memUsed: number; memTotal: number; note: string; warn?: boolean }[],
  width: number,
) {
  const row = 18
  const size = 11
  const labelW = Math.min(80, Math.max(22, ...list.map(gpu => textWidth(gpu.label, size) + 8)))
  const longest = Math.max(0, ...list.map(gpu => textWidth(gpu.note, size)))
  const textW = Math.min(width * 0.55, Math.max(96, 92 + longest))
  const barsW = Math.max(40, width - labelW - textW - 8)
  const utilW = barsW * 0.5 - 3
  const memW = barsW * 0.5 - 3
  const parts: string[] = []
  list.forEach((gpu, i) => {
    const cy = i * row + row / 2
    const busy = gpu.util >= 60 ? HUE.running : gpu.util >= 10 ? '#7aa7f0' : HUE.label
    const mem = gpu.memTotal ? gpu.memUsed / gpu.memTotal : 0
    const memColor = mem >= 0.9 ? HUE.stale : HUE.done
    const gb = (mib: number) => (mib / 1024 >= 10 ? Math.round(mib / 1024) : Math.round(mib / 102.4) / 10)
    const ink = gpu.warn ? HUE.stale : HUE.label
    parts.push(
      `<text x="0" y="${cy}" dominant-baseline="central" font-family="${FONT}" font-size="${size}" fill="${HUE.label}">${esc(fit(gpu.label, size, labelW - 4))}</text>`,
      `<rect x="${labelW}" y="${cy - 3}" width="${utilW}" height="6" rx="3" fill="${HUE.track}"/>`,
      gpu.util > 0 ? `<rect x="${labelW}" y="${cy - 3}" width="${Math.max(6, clamp(gpu.util / 100) * utilW).toFixed(1)}" height="6" rx="3" fill="${busy}"/>` : '',
      `<rect x="${labelW + utilW + 6}" y="${cy - 3}" width="${memW}" height="6" rx="3" fill="${HUE.track}"/>`,
      mem > 0.01 ? `<rect x="${labelW + utilW + 6}" y="${cy - 3}" width="${Math.max(6, mem * memW).toFixed(1)}" height="6" rx="3" fill="${memColor}"/>` : '',
      `<text x="${width}" y="${cy}" text-anchor="end" dominant-baseline="central" font-family="${FONT}" font-size="${size}" fill="${ink}">${gpu.util}% · ${gb(gpu.memUsed)}/${gb(gpu.memTotal)}G · ${esc(fit(gpu.note, size, textW - 90))}</text>`,
    )
  })
  return { source: svg(width, list.length * row, parts.join('')), height: list.length * row }
}

/**
 * Meters side by side, btop-style: a gray label, a short bar and the
 * percentage. A bar turns amber from 80% and red from 95%.
 */
export function meters(items: { label: string; ratio: number }[], barW = 46) {
  const size = 11
  const h = 14
  const gap = 12
  let x = 0
  const parts: string[] = []
  for (const item of items) {
    const ratio = clamp(item.ratio)
    const fill = ratio >= 0.95 ? HUE.failed : ratio >= 0.8 ? HUE.stale : HUE.running
    // Latin capitals run wider than the half-em textWidth allows for.
    const labelW = [...item.label].length * size * 0.72 + 5
    const value = `${Math.round(ratio * 100)}%`
    parts.push(
      `<text x="${x}" y="${h / 2}" dominant-baseline="central" font-family="${FONT}" font-size="${size}" fill="${HUE.label}">${esc(item.label)}</text>`,
      `<rect x="${x + labelW}" y="${h / 2 - 3}" width="${barW}" height="6" rx="3" fill="${HUE.track}"/>`,
      ratio > 0 ? `<rect x="${x + labelW}" y="${h / 2 - 3}" width="${Math.max(6, ratio * barW).toFixed(1)}" height="6" rx="3" fill="${fill}"/>` : '',
      `<text x="${x + labelW + barW + 4}" y="${h / 2}" dominant-baseline="central" font-family="${FONT}" font-size="${size}" fill="${HUE.label}">${value}</text>`,
    )
    x += labelW + barW + 4 + textWidth('100%', size) + gap
  }
  const width = Math.ceil(x - gap)
  return { source: svg(width, h, parts.join('')), width, height: h }
}
