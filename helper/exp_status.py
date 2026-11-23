"""Report an experiment run's progress for the exp-monitor pane.

Each run writes one JSON line to ~/.exp_status/<id>.json (atomically), which
the pane reads over ssh. Python standard library only.

    from exp_status import ExpStatus

    with ExpStatus("gate-lr3e-4", project="tta", stage="gate", name="lr=3e-4 seed0", total=5000) as st:
        for step in range(5000):
            loss = train_step()
            st.update(step + 1, loss=loss)        # throttled, cheap to call every step
    # leaving the block marks the run done, or failed on an exception

A project's stages (written once, by cc, from the project's storyline):

    set_plan("tta", title="TTA 崩塌机理", current="gate", stages=[
        {"id": "probe", "title": "入口探针", "goal": "确认现象在 2 个模型上存在"},
        {"id": "gate", "title": "Gate", "goal": "单数据集验证主结论"},
    ])

Shell / CLI (e.g. for non-Python jobs):

    python exp_status.py --project tta --id smoke-1 --stage smoke --status running --step 10 --total 100
    python exp_status.py --id smoke-1 --status done
    python exp_status.py --clear smoke-1
    python exp_status.py --project tta --plan plan.json     # or --current gate to move on

Every run carries `project` (default: $EXP_PROJECT, else "default") and `stage`,
which should be one of that project's plan stage ids.
"""

import argparse
import json
import os
import tempfile
import time

DEFAULT_DIR = os.environ.get("EXP_STATUS_DIR", "~/.exp_status")
DEFAULT_PROJECT = os.environ.get("EXP_PROJECT", "default")


class ExpStatus:
    def __init__(self, id, stage="other", name=None, total=None, project=DEFAULT_PROJECT,
                 dir=DEFAULT_DIR, every=10.0, note=None, spark=None):
        self.dir = os.path.expanduser(dir)
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, f"{_safe(project)}--{_safe(id)}.json")
        self.every = every
        self._last = 0.0
        self._mark = None  # (time, step) of the last rate sample
        self._spark = spark  # the metric whose recent values the pane draws
        old = _load(self.path)
        now = time.time()
        self.data = {
            "id": id,
            "project": project,
            "stage": stage,
            "name": name or id,
            "status": "running",
            "started": old.get("started", int(now)) if old.get("status") == "running" else int(now),
            "updated": int(now),
            "total": total,
            "step": 0,
            "metrics": {},
            "note": note,
        }
        self._write()

    def update(self, step=None, note=None, force=False, **metrics):
        if step is not None:
            self.data["step"] = step
        if note is not None:
            self.data["note"] = note
        if metrics:
            self.data["metrics"].update({k: _num(v) for k, v in metrics.items()})
        if force or time.time() - self._last >= self.every:
            self._sample()
            self._write()

    # Steps per second over the last minute or so, smoothed, so the pane's ETA
    # leaves out warm-up and data loading and follows the current speed.
    def _sample(self):
        now, step = time.time(), self.data.get("step") or 0
        if self._mark is None:
            self._mark = (now, step)
            return
        t0, s0 = self._mark
        if now - t0 < 60:
            return
        self._sample_metric()
        if step <= s0:
            return
        rate = (step - s0) / (now - t0)
        old = self.data.get("rate")
        self.data["rate"] = round(rate if old is None else 0.3 * rate + 0.7 * old, 6)
        self._mark = (now, step)

    def _sample_metric(self):
        metrics = self.data.get("metrics") or {}
        name = self._spark or next((k for k, v in metrics.items() if isinstance(v, float)), None)
        if name is None or not isinstance(metrics.get(name), float):
            return
        self._spark = name
        self.data["sparkName"] = name
        self.data["spark"] = (self.data.get("spark") or [])[-39:] + [round(metrics[name], 6)]

    def done(self, note=None, **metrics):
        self._finish("done", note, metrics)

    def fail(self, note=None, **metrics):
        self._finish("failed", note, metrics)

    def _finish(self, status, note, metrics):
        self.data["status"] = status
        self.data["finished"] = int(time.time())
        if status == "done" and self.data.get("total"):
            self.data["step"] = self.data["total"]
        self.update(note=note, force=True, **metrics)

    def __enter__(self):
        return self

    def __exit__(self, kind, value, _tb):
        if self.data["status"] == "running":
            if kind is None:
                self.done()
            elif issubclass(kind, KeyboardInterrupt):
                self._finish("killed", "interrupted", {})
            else:
                self.fail(note=f"{kind.__name__}: {value}"[:200])
        return False

    def _write(self):
        self.data["updated"] = int(time.time())
        self._last = time.time()
        _dump(self.path, {k: v for k, v in self.data.items() if v is not None})


def set_plan(project, stages=None, title=None, current=None, dir=DEFAULT_DIR, status=None):
    """Write a project's stage plan: stages are ids or {id, title, goal, status}.

    What is not given keeps its old value. `status` closes or reopens the whole
    project: "done", "failed", "paused", or "active".
    """
    root = os.path.expanduser(dir)
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, f"{_safe(project)}.plan.json")
    plan = _load(path)
    plan.update({"kind": "plan", "project": project})
    plan["title"] = title or plan.get("title") or project
    plan["stages"] = stages if stages is not None else plan.get("stages", [])
    if current is not None:
        plan["current"] = current
    if status is not None:
        plan["status"] = status
    plan["updated"] = int(time.time())
    _dump(path, {k: v for k, v in plan.items() if v is not None})


def _dump(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, path)


def _safe(id):
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in str(id))


def _num(v):
    try:
        return float(v.item() if hasattr(v, "item") else v)
    except (TypeError, ValueError):
        return str(v)


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--id")
    p.add_argument("--project", default=DEFAULT_PROJECT)
    p.add_argument("--plan", metavar="FILE", help="set the project's plan from a JSON file ({title?, current?, stages})")
    p.add_argument("--current", metavar="STAGE", help="set the project's current stage")
    p.add_argument("--project-status", choices=["active", "done", "failed", "paused"],
                   help="close or reopen the whole project")
    p.add_argument("--stage")
    p.add_argument("--name")
    p.add_argument("--status", choices=["queued", "running", "done", "failed", "killed"])
    p.add_argument("--step", type=float)
    p.add_argument("--total", type=float)
    p.add_argument("--note")
    p.add_argument("--metric", action="append", default=[], help="key=value, repeatable")
    p.add_argument("--clear", metavar="ID", help="delete a run's status file")
    p.add_argument("--dir", default=DEFAULT_DIR)
    a = p.parse_args()
    root = os.path.expanduser(a.dir)
    if a.clear:
        for name in (f"{_safe(a.project)}--{_safe(a.clear)}.json", f"{_safe(a.clear)}.json"):
            try:
                os.remove(os.path.join(root, name))
            except FileNotFoundError:
                pass
        return
    if a.plan or ((a.current or a.project_status) and not a.id):
        spec = _load(a.plan) if a.plan else {}
        if a.plan and not isinstance(spec.get("stages"), list):
            p.error(f"{a.plan} has no stages list")
        set_plan(a.project, spec.get("stages"), spec.get("title"), a.current or spec.get("current"), a.dir,
                 a.project_status or spec.get("status"))
        return
    if not a.id:
        p.error("--id is required")
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, f"{_safe(a.project)}--{_safe(a.id)}.json")
    data = _load(path) or {"id": a.id, "project": a.project, "stage": "other", "name": a.id,
                           "status": "queued", "metrics": {}}
    now = int(time.time())
    for key in ("stage", "name", "status", "note"):
        if getattr(a, key) is not None:
            data[key] = getattr(a, key)
    for key in ("step", "total"):
        if getattr(a, key) is not None:
            data[key] = getattr(a, key)
    for pair in a.metric:
        k, _, v = pair.partition("=")
        data.setdefault("metrics", {})[k] = _num(v)
    if data["status"] == "running" and "started" not in data:
        data["started"] = now
    if data["status"] in ("done", "failed", "killed"):
        data["finished"] = now
    data["updated"] = now
    _dump(path, data)


if __name__ == "__main__":
    main()
