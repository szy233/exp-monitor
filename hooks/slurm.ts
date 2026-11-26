// Slurm clusters: what a login node prints about the scheduler and the
// person's own jobs, and those jobs as runs placed in their projects.

import type { ClusterState, Plan, Run, RunStatus, SlurmJob, SlurmNode, SlurmPartition } from '../types'

/**
 * What a cluster's login node prints: the status files in the shared home
 * (jobs on any node write there), then the scheduler: nodes, partitions, the
 * queue's size, the person's jobs now and over the last two days, their
 * fair-share, and what each of their running jobs' GPUs are doing (asked of
 * the job itself through `srun --overlap`, all jobs at once, 25 s at most).
 */
export function clusterScript(dir: string) {
  return [
    `for f in ${dir}/*.json; do [ -f "$f" ] && { echo "@@FILE $f"; cat "$f"; echo; }; done`,
    `echo "@@CNAME $(scontrol show config 2>/dev/null | awk '/^ClusterName/{print $3}')"`,
    'echo @@NODES; sinfo -N -h -O NodeList:40,Partition:30,StateCompact:14,Gres:60,GresUsed:80,CPUsState:30,AllocMem:14,Memory:14 2>/dev/null',
    "echo @@PARTS; sinfo -h -o '%P|%a|%l|%F' 2>/dev/null",
    'echo "@@QUEUE $(squeue -h -t R -o %i 2>/dev/null | wc -l) $(squeue -h -t PD -o %i 2>/dev/null | wc -l)"',
    `echo @@MINE; squeue -h -u "$USER" -o '%i|%j|%T|%M|%l|%N|%r|%b|%P|%S|%Z' 2>/dev/null`,
    'echo @@RECENT; sacct -u "$USER" -S now-2days -X -n -P -o JobID,JobName,State,Elapsed,Timelimit,NodeList,Partition,Start,End,WorkDir,ExitCode,AllocTRES 2>/dev/null',
    'echo "@@SHARE $(sshare -U -h -o FairShare 2>/dev/null | tail -n 1)"',
    'echo @@JOBGPU; g=$(mktemp -d)',
    `for j in $(squeue -h -u "$USER" -t R -o %i 2>/dev/null); do (timeout 25 srun --jobid="$j" --overlap -N1 -n1 nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | sed "s/^/$j, /" > "$g/$j") & done`,
    'wait; cat "$g"/* 2>/dev/null; rm -rf "$g"',
    'true',
  ].join('\n')
}

/** Seconds in a Slurm duration: `D-HH:MM:SS`, `HH:MM:SS` or `MM:SS`; undefined for UNLIMITED and the like. */
export function slurmSeconds(text: string | undefined): number | undefined {
  const t = (text ?? '').trim()
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return undefined
  const [, d = '0', h = '0', mi = '0', s = '0'] = m
  return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(s)
}

/** A timestamp Slurm prints (`2026-11-24T13:24:34`, local time); undefined for N/A, Unknown. */
const slurmTime = (text: string | undefined) => {
  const t = (text ?? '').trim()
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(t)) return undefined
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** GPUs in a gres or TRES string: `gpu:a800:7(IDX:...)`, `gres:gpu:a800:1`, `gres/gpu=1`. */
export function gpuCount(text: string | undefined): number {
  let n = 0
  for (const part of (text ?? '').split(/,(?![^(]*\))/)) {
    const m = part.match(/gpu(?::[\w.-]+)*?[:=](\d+)/)
    if (m) n += Number(m[1])
  }
  return n
}

export function parseSlurm(lines: string[]): ClusterState {
  const state: ClusterState = { running: 0, pending: 0, nodes: [], partitions: [], mine: [], recent: [] }
  let section = ''
  const seen = new Set<string>()
  for (const line of lines) {
    const text = line.trim()
    if (text.startsWith('@@CNAME')) state.name = text.slice(7).trim() || undefined
    else if (text.startsWith('@@QUEUE')) {
      const [running, pending] = text.slice(7).trim().split(/\s+/).map(Number)
      state.running = running || 0
      state.pending = pending || 0
    } else if (text.startsWith('@@SHARE')) {
      const share = Number(text.slice(7).trim())
      state.fairShare = Number.isFinite(share) && text.slice(7).trim() !== '' ? share : undefined
    } else if (text.startsWith('@@')) section = text
    else if (!text) continue
    else if (section === '@@NODES') {
      const [name, partition, nodeState, gres, used, cpus, alloc, mem] = text.split(/\s+/)
      if (!name || seen.has(name)) continue
      seen.add(name)
      const [cpuA, , , cpuT] = (cpus ?? '').split('/').map(Number)
      const node: SlurmNode = {
        name,
        partition: (partition ?? '').replace(/\*$/, ''),
        state: nodeState ?? '',
        gpus: gpuCount(gres),
        gpusUsed: gpuCount((used ?? '').replace(/\(.*$/, '')),
        cpus: cpuT || 0,
        cpusUsed: cpuA || 0,
        memTotal: Number(mem) || 0,
        memAlloc: Number(alloc) || 0,
      }
      state.nodes.push(node)
    } else if (section === '@@PARTS') {
      const [name, avail, limit, counts] = text.split('|')
      const [allocated, idle, other, total] = (counts ?? '').split('/').map(Number)
      const part: SlurmPartition = {
        name: (name ?? '').replace(/\*$/, ''),
        isUp: avail === 'up',
        limit: slurmSeconds(limit),
        allocated: allocated || 0,
        idle: idle || 0,
        other: other || 0,
        total: total || 0,
      }
      if (part.name) state.partitions.push(part)
    } else if (section === '@@MINE') {
      const [id, name, jobState, elapsed, limit, nodes, reason, gres, partition, start, workdir] = text.split('|')
      if (!id) continue
      state.mine.push({
        id,
        name: name ?? id,
        state: jobState ?? '',
        elapsed: slurmSeconds(elapsed) ?? 0,
        limit: slurmSeconds(limit),
        node: nodes || undefined,
        reason: reason && reason !== 'None' ? reason : undefined,
        partition,
        gpus: gpuCount(gres),
        start: slurmTime(start),
        workdir,
      })
    } else if (section === '@@JOBGPU') {
      const [id, util, used, total] = text.split(/,\s*/)
      const job = state.mine.find(one => one.id === id)
      if (job && Number.isFinite(Number(util))) {
        job.usage = [...(job.usage ?? []), { util: Number(util), memUsed: Number(used) || 0, memTotal: Number(total) || 0 }]
      }
    } else if (section === '@@RECENT') {
      const [id, name, jobState, elapsed, limit, nodes, partition, start, end, workdir, exit, tres] = text.split('|')
      if (!id || !/^\d+(_\d+)?$/.test(id)) continue
      state.recent.push({
        id,
        name: name ?? id,
        state: (jobState ?? '').split(' ')[0] ?? '',
        elapsed: slurmSeconds(elapsed) ?? 0,
        limit: slurmSeconds(limit),
        node: nodes && nodes !== 'None assigned' ? nodes : undefined,
        partition,
        gpus: gpuCount(tres),
        start: slurmTime(start),
        end: slurmTime(end),
        workdir,
        exit,
      })
    }
  }
  return state
}

export function slurmStatus(state: string): RunStatus {
  const s = state.toUpperCase()
  if (/^(RUNNING|COMPLETING|STAGE_OUT|SIGNALING)/.test(s)) return 'running'
  if (/^(PENDING|CONFIGURING|REQUEUED|RESIZING|SUSPENDED|REQUEUE)/.test(s)) return 'queued'
  if (s.startsWith('COMPLETED')) return 'done'
  if (/^(CANCELLED|TIMEOUT|PREEMPTED|REVOKED)/.test(s)) return 'killed'
  return 'failed'
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The project a job belongs to, from its working directory: the deepest
 * folder whose name holds a project's id or its folder's name, so
 * `.../my_memo/rewind_runs/x` goes to `rewind`, not `memo`.
 */
export function projectOfDir(workdir: string | undefined, keys: { project: string; names: string[] }[]): string | undefined {
  const parts = (workdir ?? '').split('/').filter(Boolean).reverse()
  for (const part of parts) {
    const n = norm(part)
    if (!n) continue
    // The folder is the project, or holds its name as a word (`old_tta_runs`),
    // or, for a name long enough not to match by chance, holds it at all.
    const words = part.toLowerCase().split(/[^a-z0-9]+/)
    const found =
      keys.find(key => key.names.some(name => name === n)) ??
      keys.find(key => key.names.some(name => words.includes(name))) ??
      keys.find(key => key.names.some(name => name.length >= 5 && n.includes(name)))
    if (found) return found.project
  }
  return undefined
}

export const UNSORTED = (where: string) => `cluster:${where}`

/**
 * The person's cluster jobs as runs. A job whose status file names its Slurm
 * id (written in the job, or by a sidecar elsewhere with `--slurm-job`) lends
 * that run its scheduler facts; any other job becomes a run of its own, in the
 * project its folder names, or in the cluster's unsorted group.
 */
export function clusterRuns(
  runs: Run[],
  plans: Plan[],
  clusters: { where: string; cluster: ClusterState }[],
  roots: { project: string; root: string }[],
  at: number,
): { runs: Run[]; plans: Plan[] } {
  const keys = plans.map(plan => ({
    project: plan.project,
    names: [
      norm(plan.project),
      ...roots.filter(one => one.project === plan.project).map(one => norm(one.root.split('/').filter(Boolean).pop() ?? '')),
    ].filter(Boolean),
  }))
  const out = [...runs]
  const extra: Plan[] = []
  for (const { where, cluster } of clusters) {
    const recent = cluster.recent.filter(job => !cluster.mine.some(one => one.id === job.id))
    const jobs = [...cluster.mine, ...recent]
    // A job submitted from elsewhere (its home, say) goes where a job of the same name went.
    const byName = new Map<string, string>()
    for (const job of jobs) {
      const project = projectOfDir(job.workdir, keys)
      if (project && !byName.has(job.name)) byName.set(job.name, project)
    }
    for (const job of jobs) {
      const status = slurmStatus(job.state)
      // The job's own status file, read on the cluster or wherever a sidecar
      // that watches it keeps one; the cluster's own copy first.
      const byId = (run: Run) => run.slurm?.id === job.id && (run.where === where || !clusters.some(one => one.where === run.where))
      const own = out.findIndex(run => byId(run) && run.where === where)
      const reported = own >= 0 ? own : out.findIndex(byId)
      if (reported >= 0) {
        const kept = { ...out[reported]!, slurm: { ...job } }
        // One job is one run: a sidecar's copy gives way to the job's own file.
        for (let i = out.length - 1; i >= 0; i--) if (i !== reported && byId(out[i]!)) out.splice(i, 1)
        out[out.findIndex(run => run.where === kept.where && run.id === kept.id && run.project === kept.project)] = kept
        continue
      }
      const project = projectOfDir(job.workdir, keys) ?? byName.get(job.name) ?? UNSORTED(where)
      if (project === UNSORTED(where) && !extra.some(plan => plan.project === project)) {
        extra.push({ project, title: `${cluster.name ?? where} · 未归类作业`, stages: [], updated: 0, where })
      }
      out.push({
        id: `slurm-${job.id}`,
        project,
        stage: '',
        name: job.name,
        host: job.node ?? cluster.name ?? where,
        status,
        started: job.start ?? (status === 'running' ? at - job.elapsed : undefined),
        updated: status === 'running' || status === 'queued' ? at : job.end ?? at,
        finished: job.end,
        note:
          status === 'failed' || status === 'killed'
            ? `${job.state}${job.exit && job.exit !== '0:0' ? ` · exit ${job.exit}` : ''}`
            : undefined,
        where,
        slurm: { ...job },
      })
    }
  }
  return { runs: out, plans: [...plans, ...extra] }
}
