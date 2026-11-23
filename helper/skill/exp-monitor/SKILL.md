---
name: exp-monitor
description: Design a research project's experiment stages from its storyline and report run progress so the exp-monitor pane can show it. Use when starting or re-planning a project ("设计实验阶段", "规划阶段", "更新阶段"), when dispatching experiments to remote servers, when a stage finishes and the project moves on, or when asked why the progress pane shows nothing.
---

# exp-monitor: stages and progress for the monitor pane

A pane on the person's client reads `~/.exp_status/*.json` on every server over ssh, every half
hour by default. Two kinds of files live there, written atomically by `~/.exp_status/exp_status.py`
(copy it to each server if it is missing; standard library only):

- `<project>.plan.json`: the project's stages, written by you. One per project, on the hub.
- `<project>--<run>.json`: one run's progress, written by the job itself while it trains.

## 0. Initializing a project (the pane asks for it the first time it opens there)

A message headed `[exp-monitor 初始化]` comes from the pane: run steps 1–2 below for the
project, check the servers it uses, and finish by writing `<project root>/.claude/exp-monitor.json`:

```json
{"project": "tta", "title": "TTA 崩塌机理", "workers": ["local", "gpu-a", "me@gpu-b"]}
```

`project` is the id every plan and run uses; `workers` are ssh aliases as seen from the hub
(`local` is the hub itself), only ones that answer `ssh -o BatchMode=yes <host> true`. For each
worker report in one table: reachable, python3, `~/.exp_status/exp_status.py` present (copy it
from the hub's `~/.exp_status/` when missing), and `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader`.
The pane reloads the file by itself; `/exp-init` asks for initialization again. A folder that is
no experiment project gets `{"skip": true}`, which hides the pane's band there.

## 1. Design the stages (once per project, and again when the plan changes)

Read the project before writing anything: its README / CLAUDE.md, the storyline or paper
outline, the prereg or plan notes, the experiment configs and scripts already there. Then cut
the work into **4–7 stages in the order they will run**, each one a decision point the
storyline depends on, not a generic phase name. Good stages name what they establish:

| id | title | goal |
| --- | --- | --- |
| `probe` | 入口探针 | 现象在 2 个模型、1 个数据集上可复现 |
| `gate` | Gate 验证 | 主结论在 CIFAR-10-C 上成立，效应 > 2σ |
| `full` | 全量实验 | 5 数据集 × 3 seeds 主表 |
| `ablate` | 消融 | 去掉每个组件的贡献 |
| `analysis` | 机理分析 | 支撑 §5 的可视化与统计 |

`id` is short ASCII (runs refer to it); `title` is what the pane shows; `goal` is one line the
pane shows under the current stage. Write it:

```bash
cat > /tmp/plan.json <<'EOF'
{"title": "TTA 崩塌机理", "current": "probe",
 "stages": [{"id": "probe", "title": "入口探针", "goal": "..."}, {"id": "gate", "title": "Gate 验证", "goal": "..."}]}
EOF
python3 ~/.exp_status/exp_status.py --project tta --plan /tmp/plan.json
```

Tell the person the stages in one short table and ask before overwriting a plan they already
have. When a stage is finished or abandoned, move on with
`python3 ~/.exp_status/exp_status.py --project tta --current gate`; a stage may also carry
`"status": "done" | "skipped"` in the plan to override what the runs imply.

## 2. Report every run you dispatch

Every job you start on any server must report, with the project and one of the plan's stage ids:

- **Python training script** (preferred): wrap the loop.

  ```python
  import sys, os; sys.path.insert(0, os.path.expanduser("~/.exp_status"))
  from exp_status import ExpStatus
  with ExpStatus("gate-lr3e-4-s0", project="tta", stage="gate", name="lr3e-4 s0", total=num_steps) as st:
      for step in ...:
          st.update(step + 1, loss=loss, acc=acc)   # throttled, safe every step
  ```

  Leaving the block marks it done; an exception marks it failed with the error.
- **Anything else**: report from the launching shell around the command.

  ```bash
  R="python3 ~/.exp_status/exp_status.py --project tta --id eval-c10"
  $R --stage gate --status running --total 1 && cmd ... && $R --status done || $R --status failed --note "exit $?"
  ```

Use a distinct `--id` per run (stage, config, seed). Queued jobs may be reported up front with
`--status queued`. Do not delete status files of finished runs; `--clear <id>` removes one the
person asks to drop.

A job registered after it started (a sidecar, a run picked up mid-training) has no true start:
report `step` and `updated` every time you look and the pane estimates the time left from how far
the step moved between its half-hourly reads. Report `step`/`total` in the job's own units only
when a step count exists; a batch of N jobs reports `total: N` and `step` as how many finished.

## 3. Closing a project, and what the pane says it is doing

- When a project is finished, failed or paused, close it:
  `python3 ~/.exp_status/exp_status.py --project tta --project-status done` (or `failed`, `paused`;
  `active` reopens it; the rest of the plan is kept). The pane folds it under its idle group. The person archives it
  from the pane's 管理 menu, which moves its files to `~/.exp_status/archive/<date>/`; restore one
  by moving it back.
- The pane's "正在 / 下一步" lines and the short stage names are written by a model from the
  project's latest git commits (or, outside git, the tail of its newest `research/*.md` / `*.md`
  note such as LEDGER.md). Commit messages and ledger entries that name the experiment and its
  verdict (`GATE-1: receipt; P1 met on 3 seeds`, `rule on FULL-1 (pass)`) are what make those lines right.
