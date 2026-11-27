# exp-monitor

A [Claude Code](https://claude.com/claude-code) plugin that keeps a pane beside the chat for research
experiments running on several servers. It reads each job's progress over ssh and shows, without you
asking Claude for a status every time:

- **Tasks tab** — a strip of totals across all projects (running, queued, finished today, failed,
  lost), then one project open at a time: an overall progress ring, one "doing now" line written from
  the project's latest git commits or notes, its stages as a pipeline, and its running jobs as a
  table, one line each with aligned columns: name, machine, progress bar, %, time left. Names drop
  the notes people put in brackets and are cut in the middle when long, so `…_s1` and `…_s2` stay
  apart. Other projects take one line each; closed or quiet ones fold away.
- **Resources tab** — every machine any of your projects uses, btop-style: its shortest name with CPU
  (measured from `/proc/stat`) and memory meters on the title line, then per GPU its load, memory and
  who is using it. A **Slurm cluster** is drawn the same way: its
  GPUs are the ones your running jobs hold, each with its real load, memory, job and the time left
  before the job's limit; idle GPUs and jobs near their limit are flagged.
- **A row above the prompt** with the session's project progress and a button that opens the pane.
- **Notifications** when a job finishes or fails: once, whichever session sees it first, and only
  for jobs that ended in the last six hours.
- **Instant start**: every session shares the last refresh, so a new session shows it at once, its
  own project first and open, and refreshes in the background only when it is older than five
  minutes.

The pane's own text is in Chinese.

## Requirements

- **Claude Code 2.1.309 or later**, in a terminal, the desktop app or an SSH session from the desktop
  app. The plugin is a hooks module, which older builds do not load.
- **A hub**: one machine that can `ssh` to every server that runs jobs **without a password**
  (keys, `~/.ssh/config` aliases). Usually the machine you open Claude Code sessions on.
- **Python 3** on every server that runs jobs (the reporter uses the standard library only).
- `nvidia-smi` on GPU servers, for the Resources tab (optional).
- For a **Slurm cluster** (optional): password-less ssh from the hub to its login node; `squeue`,
  `sinfo`, `sacct` there, and `srun --overlap` (Slurm 20.11+) to read your jobs' GPU load.

## Installation

### 1. Install the plugin

Install it on the machine where your Claude Code sessions run. If you open sessions on a remote
server over SSH from the desktop app, that is the server: run these commands there.

At the prompt of a Claude Code terminal session:

```
/plugin install exp-monitor --marketplace szy233/exp-monitor
```

Answer `y` to add the marketplace and choose the **user** scope (so every session loads it). The
installer then shows the plugin's options; the defaults are fine for now. Or from a shell:

```bash
claude plugin install exp-monitor --marketplace szy233/exp-monitor
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins** → **Add marketplace** with `szy233/exp-monitor` → **Add plugin**.

Sessions that were already open load it after `/reload-plugins`; new sessions load it by themselves.

### 2. Tell it where your servers are

Open `/config` in a session (or the plugin's settings in the desktop app) and set, under exp-monitor:

| option | what to put |
| --- | --- |
| `hub` | Leave **empty** if your sessions run on the hub. Otherwise the ssh alias of the hub as this machine sees it. |
| `workers` | Comma-separated ssh aliases of the servers that run jobs, **as the hub sees them**. `local` means the hub itself. Example: `local,gpu-a,me@gpu-b` |
| `clusters` | Comma-separated ssh aliases of **Slurm login nodes**, as the hub sees them. Leave empty if you have none. |

Check that each one works without a password, from the hub:

```bash
ssh -o BatchMode=yes gpu-a true && echo ok
```

Each project also lists its machines in its own `.claude/exp-monitor.json` (step 4 writes it). Every
session reads the machines of **all** projects plus these options, so the Resources tab and the job
list are the same wherever you open the pane.

### 3. Install the reporter and the skill

Jobs report their progress through `helper/exp_status.py`, a single file that writes small JSON files
to `~/.exp_status/`. The skill in `helper/skill/` teaches Claude how to design a project's stages and
how to make every job it starts report. On the hub:

```bash
git clone https://github.com/szy233/exp-monitor.git
mkdir -p ~/.exp_status ~/.claude/skills
cp exp-monitor/helper/exp_status.py ~/.exp_status/
cp -r exp-monitor/helper/skill/exp-monitor ~/.claude/skills/
```

Then copy the reporter to every worker (replace the aliases with yours):

```bash
for h in gpu-a me@gpu-b; do ssh "$h" mkdir -p .exp_status && scp exp-monitor/helper/exp_status.py "$h":.exp_status/; done
```

On a cluster, copy it once to the login node's home: the compute nodes share it.

### 4. Initialize a project

Open a Claude Code session in a project folder. The first time the pane opens there, it asks Claude
to initialize the project (turn this off with the `autoInit` option; `/exp-init` asks at any time).
Claude then:

1. reads the project (README, CLAUDE.md, storyline or paper outline, configs and scripts);
2. proposes 4–7 stages that follow the project's storyline, and **asks you to confirm** them before
   writing the plan;
3. checks every server: password-less ssh, Python 3, the reporter, GPU use;
4. writes `.claude/exp-monitor.json` with the project's id, title and servers;
5. lists the training or launch scripts that should report, and asks before changing them.

In a folder that is not an experiment project, Claude writes `{"skip": true}` there instead and the
pane stays out of the way.

### 5. Make jobs report

From a Python training loop:

```python
import os, sys
sys.path.insert(0, os.path.expanduser("~/.exp_status"))
from exp_status import ExpStatus

with ExpStatus("gate-lr3e-4-s0", project="tta", stage="gate", name="lr3e-4 s0", total=num_steps) as st:
    for step in range(num_steps):
        loss = train_step()
        st.update(step + 1, loss=loss)   # cheap: writes at most once per 10 s
# leaving the block marks the job done; an exception marks it failed, with the error
```

From a shell, around any command:

```bash
R="python3 ~/.exp_status/exp_status.py --project tta --id eval-c10"
$R --stage gate --status running --total 1 && ./eval.sh && $R --status done || $R --status failed --note "exit $?"
```

Once the skill is installed, Claude adds this to the jobs it starts.

**On a Slurm cluster** every job of yours shows up without any of this: the pane reads `squeue` and
`sacct` and places each job in the project whose name appears in its working directory (submit from
the project's folder). Inside a job the reporter records `$SLURM_JOB_ID` itself, so the job's
progress and its scheduler facts show as one run. To report a job from outside it (a sidecar that
reads its log), pass the id so it is not shown twice:

```bash
python3 ~/.exp_status/exp_status.py --project tta --id gate-s0 --slurm-job 123456 --step 36000 --total 50000
```

A run with no step shows 进度未上报 ("progress not reported") and gets no time-left estimate.

### 6. Check that it works

- Run `/exp` to open the pane and refresh now, or `/exp-status` for a text summary in the chat.
- The Resources tab should list every worker with its GPUs. A server shown as unreachable fails the
  `ssh -o BatchMode=yes` test from step 2.
- A job appears within one refresh (every 30 minutes by default; ⟳ or `r` refreshes at once).

## Using it

- **Time left** comes from how far a job's step actually moved across refreshes, so evaluation and
  checkpoint pauses are included. Until there is such a trend it uses the job's own rate, or shows
  估算中 ("estimating"). Durations are rounded to half hours (`<30min`, `~1.5h`, `~2d`).
- A running job that stops writing is marked 停滞 (stalled) after `staleMin` minutes and 失联 (lost)
  after `lostHours` hours, when it no longer counts as running.
- **管理** (manage) on a project offers 清理已结束 (clear finished jobs) and 归档整个项目 (archive the
  project), each confirmed by a second press; **明细** (details) lists ended jobs, each with ✕.
  Nothing is deleted: the files move to `~/.exp_status/archive/<date>/` on their servers.
- Close a finished project so it folds away:
  `python3 ~/.exp_status/exp_status.py --project tta --project-status done` (or `failed`, `paused`;
  `active` reopens it).
- The "doing now / next" lines are written by the `haiku` model when a project's git log, newest
  notes or set of running jobs change (at most hourly), and count toward your Claude usage. Turn
  them off with the `digests` option.
- On a cluster row, 时限剩 is the time before the job's limit (amber under 12 hours: save a
  checkpoint or resubmit), and 空转 marks a GPU your job holds at under 5% load.

### Commands

| command | what it does |
| --- | --- |
| `/exp` | open the pane and refresh now |
| `/exp-status` | print a text summary into the chat |
| `/exp-init` | ask Claude to initialize the current project |

### All options

| option | default | meaning |
| --- | --- | --- |
| `hub` | *(empty)* | ssh alias of the hub from this machine; empty means this machine is the hub |
| `workers` | `local` | comma-separated aliases reachable from the hub; `local` is the hub itself |
| `clusters` | *(empty)* | comma-separated Slurm login-node aliases reachable from the hub |
| `statusDir` | `~/.exp_status` | where status files live on each server |
| `intervalSec` | `1800` | seconds between refreshes |
| `staleMin` | `60` | minutes without an update before a running job is stalled |
| `lostHours` | `6` | hours without an update before a running job is lost |
| `autoInit` | `true` | ask Claude to initialize a project the first time the pane opens in it |
| `digests` | `true` | write the "doing now / next" lines with `haiku` when a project's records change |
| `projectRoots` | `~/research/*,~/*` | where the hub looks for initialized projects to read their records |

## Updating and uninstalling

```bash
claude plugin marketplace update exp-monitor
claude plugin update exp-monitor@exp-monitor
```

Then `/reload-plugins` in open sessions. Copy the new `helper/exp_status.py` and skill as in step 3
when they change. To remove the plugin: `claude plugin uninstall exp-monitor@exp-monitor`.

## How it works

Every refresh, the plugin sends one shell script to the hub (over ssh, or locally when `hub` is
empty). The hub reads every worker and cluster in parallel — each `~/.exp_status/*.json`, load,
memory and `nvidia-smi`; on a cluster, `sinfo`, `squeue`, `sacct` and, through
`srun --overlap`, each running job's GPUs — plus the machines and the latest git commits or notes of
each project whose `.claude/exp-monitor.json` lies under `projectRoots`. Aliases that reach the same
machine are read once. Nothing is installed on the workers beyond the reporter file.

## License

[MIT](LICENSE)
