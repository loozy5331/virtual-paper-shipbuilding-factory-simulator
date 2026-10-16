"""균형 점검(D15): "이것 하나만 고르면 끝"인 지배 전략이 없는지 숫자로 본다.

    cd engine && python -m tools.balance              # 모든 분기
    cd engine && python -m tools.balance growth -n 30  # 수주 증가, 시작점 30개
    cd engine && python -m tools.balance -j 1          # 프로세스 하나로(기본은 코어 수만큼 나눠 돈다)

선택지 공간이 커서(공정 10개마다 인력·공법·잔업·정비·작업장 수·나눠 하기·호이스트, 자재 등급, 직종별 인원, 연구, 발주, 착수 간격)
전수 대신 무작위 시작점에서 한 칸씩 바꿔 점수가 오르면 옮기는 언덕 오르기를 여러 번 한다.
4.0부터는 이웃(한 칸씩 바꾼 설정)을 섞어 돌다가 처음 오르는 칸으로 옮긴다(공정이 10개라 매번 이웃을 다 돌면 너무 느리다). 결과로
  1. 찾은 최고 설정과 점수
  2. 상위 설정들에서 선택지별 사용 비율 (모든 상위 설정이 같은 값을 쓰면 그 선택이 지배적일 수 있다)
  3. "모든 공정을 X로 고정"했을 때의 최고 점수 (최고와 거의 같으면 그 X 하나로 끝나는 전략이다)
를 낸다. 엔진만 쓰고 결과는 화면에 찍기만 한다.
언덕 오르기는 시작점마다 따로라 프로세스 여럿에 나눠 돈다. 시작점과 난수 씨앗은 먼저 정해 두므로 -j와 상관없이 결과가 같다.
"""

from __future__ import annotations

import argparse
import copy
import functools
import os
import random
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Callable, Iterable

from shipyard.sim import DISPATCH_RULES, active_trades, block_counts, is_skipped, load_scenario, scenario_ids, simulate

RESEARCH_SETS = [[], ["automation"], ["auto_inspect"], ["predictive"], ["automation", "auto_inspect"],
                 ["automation", "predictive"], ["auto_inspect", "predictive"], ["automation", "auto_inspect", "predictive"]]


def active_stations(sc: dict[str, Any]) -> list[dict[str, Any]]:
    """시나리오가 쓰는 공정(간이공정은 일부가 빠진다, 4.4)."""
    return [st for st in sc["stations"] if not is_skipped(st)]


def space(sc: dict[str, Any]) -> dict[str, list[Any]]:
    """바꿀 수 있는 칸과 그 값들. 공정 칸은 '<공정>.<항목>'이다."""
    rules = sc["rules"]
    # 분기가 열어 둔 옵션만 고른다(D33). options가 없으면 모두.
    opts = sc.get("options") or {"crews": list(rules["crews"]), "methods": list(rules["methods"]),
                                 "material_grades": list(sc["material_grades"]),
                                 "max_units": sc["expansion"]["max_units"], "split": True}
    out: dict[str, list[Any]] = {}
    for st in active_stations(sc):
        pid = st["id"]
        trial = st.get("trade") == "trial"
        # 시운전팀은 인력·잔업을 고르지 않는다(4.0 D42, 4.22 D69). 인원은 아래 직종별 인원에서 고른다
        out[f"{pid}.crew"] = ["normal"] if trial else list(opts["crews"])
        out[f"{pid}.method"] = list(opts["methods"])
        out[f"{pid}.overtime"] = [False] if trial else [False, True]
        out[f"{pid}.maintenance"] = [False, True]
        cap = sc["expansion"].get("max_units_by_station", {}).get(pid, opts["max_units"])
        out[f"{pid}.units"] = list(range(1, min(opts["max_units"], cap) + 1))
        # 나눠 하기(3.0): 나눌 수 있는 공정(rules.json의 split)만
        out[f"{pid}.split"] = [False, True] if opts["split"] and st.get("split", True) else [False]
        # 호이스트(4.9): 분기가 열었고 달 수 있는 공정(rules.json의 hoist)만
        out[f"{pid}.hoist"] = [False, True] if opts.get("hoist") and st.get("hoist") else [False]
        # 공정 여유(4.15, D62): 분기가 열었을 때만 0~max_days일
        out[f"{pid}.buffer"] = list(range(sc["plan_buffer"]["max_days"] + 1)) if opts.get("plan_buffer") else [0]
        # 블록 우선순위 규칙(4.25, D71): 블록 조립 실습의 블록 공정만
        out[f"{pid}.dispatch"] = list(DISPATCH_RULES) if pid in block_counts(sc) else ["ship"]
    for m in sc["materials"]:
        out[f"material.{m['id']}"] = list(opts["material_grades"])
    # 직종별 대기소 인원(4.0, D42)
    for t in active_trades(sc):
        out[f"pool.{t}"] = list(range(1, sc["trades"][t]["max"] + 1))
    if opts.get("trial_pools") and "pool.trial" in out:   # 시운전 인원을 고정한 분기(간이공정, 4.22)
        out["pool.trial"] = list(opts["trial_pools"])
    out["tr_count"] = list(opts.get("transporter_counts") or [1])   # 블록 트랜스포터(4.8): 분기가 연 대수만
    out["tr_maintenance"] = [False, True]
    # 공용 지게차(4.3, D46): 분기가 연 대수만(기본 반기는 2대 고정)
    fk = sc["forklift"]
    out["fk_count"] = list(opts.get("forklift_counts") or range(1, fk["max_count"] + 1))
    out["fk_maintenance"] = [False, True]
    out["research"] = list(range(len(RESEARCH_SETS)))
    out["ordering"] = list(sc["ordering"])
    # 역산 발주 여유일(4.13, D59): 분기가 열었을 때만 0~buffer_max일
    jit = sc["ordering"]["jit"]
    out["jit_buffer"] = list(range(jit["buffer_max"] + 1)) if opts.get("jit_buffer") else [jit["buffer_days"]]
    # 안전 재고(4.14, D60): 분기가 열었을 때만 자재마다 0·1·2척분
    for m in sc["materials"]:
        out[f"safety.{m['id']}"] = list(sc["safety_stock"]["levels"]) if opts.get("safety_stock") else [0]
    out["gap"] = [1, 2, 3, 4, 5, 6, 8]
    return out


def to_config(sc: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    """칸 값 묶음 → 엔진 설정. 우선순위는 납기순, 착수는 1일부터 gap일 간격."""
    by_due = sorted(sc["orders"], key=lambda o: (o["due_day"], o["id"]))
    return {
        "scenario": sc["id"],
        "ordering": plan["ordering"],
        "jit_buffer": plan["jit_buffer"],
        "safety_stock": {m["id"]: plan[f"safety.{m['id']}"] for m in sc["materials"] if plan[f"safety.{m['id']}"]},
        "ships": {o["id"]: {"priority": k + 1, "start_day": min(sc["days"], 1 + k * plan["gap"])} for k, o in enumerate(by_due)},
        "stations": {st["id"]: {key: plan[f"{st['id']}.{key}"] for key in ("crew", "method", "overtime", "maintenance", "units", "split", "hoist", "buffer", "dispatch")}
                     for st in active_stations(sc)},
        "materials": {m["id"]: plan[f"material.{m['id']}"] for m in sc["materials"]},
        "pools": {name.split(".", 1)[1]: v for name, v in plan.items() if name.startswith("pool.")},
        "transporters": {"count": plan["tr_count"], "maintenance": plan["tr_maintenance"]},
        "forklifts": {"count": plan["fk_count"], "maintenance": plan["fk_maintenance"]},
        "research": RESEARCH_SETS[plan["research"]],
        "skilled_station": None,
    }


def score(sc: dict[str, Any], plan: dict[str, Any]) -> float:
    """등급 점수. 점수는 이익 상한(목표의 1.3배)에서 멈추므로, 같은 점수끼리는 이익으로 가른다(이익 1,000 = 0.01점)."""
    r = simulate(to_config(sc, plan), sc, baseline=False)
    return r["grade"]["score"] + r["profit"] / 100_000


def climb(sc: dict[str, Any], sp: dict[str, list[Any]], start: dict[str, Any], fixed: dict[str, Any],
          cache: dict[tuple, float], rng: random.Random) -> tuple[float, dict[str, Any]]:
    """이웃(한 칸씩 바꾼 설정)을 섞어 돌다가 점수가 오르는 첫 칸으로 옮긴다. 이웃을 다 돌아도 안 오르면 멈춘다.

    3.x는 매 걸음 이웃을 다 돌아 가장 많이 오르는 쪽으로 옮겼다. 공정 10개(4.0)에서는 이웃이 70~120개라
    너무 느려서 첫 개선으로 바꿨다(같은 언덕 오르기라 멈춘 곳은 어느 칸을 바꿔도 안 오르는 설정이다).
    """
    def value(plan: dict[str, Any]) -> float:
        key = tuple(sorted(plan.items()))
        if key not in cache:
            cache[key] = score(sc, plan)
        return cache[key]

    plan = {**start, **fixed}
    best = value(plan)
    moves = [(name, v) for name, values in sp.items() if name not in fixed for v in values]
    while True:
        rng.shuffle(moves)
        for name, v in moves:
            if v == plan[name]:
                continue
            trial = {**plan, name: v}
            got = value(trial)
            if got > best + 1e-9:
                best, plan = got, trial
                break
        else:
            return best, plan


@functools.lru_cache(maxsize=None)
def _scenario(scenario_id: str) -> dict[str, Any]:
    return load_scenario(scenario_id)


def _climb_job(job: tuple[str, dict[str, Any], dict[str, Any], int]) -> tuple[float, dict[str, Any], int]:
    """프로세스 하나가 맡는 언덕 오르기 한 번. 캐시는 그 오르기 안에서만 쓴다. (점수, 설정, 실행 횟수)"""
    scenario_id, start, fixed, seed = job
    sc = _scenario(scenario_id)
    cache: dict[tuple, float] = {}
    best, plan = climb(sc, space(sc), start, fixed, cache, random.Random(seed))
    return best, plan, len(cache)


def run(scenario_id: str, starts: int, seed: int, report: Callable[[str], None] = print,
        pool: ProcessPoolExecutor | None = None) -> dict[str, Any]:
    began = time.time()
    sc = _scenario(scenario_id)
    sp = space(sc)
    rng = random.Random(seed)
    runs = 0

    def climbs(jobs: Iterable[tuple[dict[str, Any], dict[str, Any]]]) -> list[tuple[float, dict[str, Any]]]:
        nonlocal runs
        tasks = [(scenario_id, start, fixed, rng.randrange(2**32)) for start, fixed in jobs]
        out = []
        for best, plan, n in (pool.map(_climb_job, tasks) if pool else map(_climb_job, tasks)):
            runs += n
            out.append((best, plan))
        return out

    found = climbs([({name: rng.choice(values) for name, values in sp.items()}, {}) for _ in range(starts)])
    found.sort(key=lambda r: -r[0])
    best_score, best_plan = found[0]

    report(f"\n=== {sc['name']} ({len(sc['orders'])}척): 시작점 {starts}개, 실행 {runs}번 ===")
    report(f"최고 {best_score:.1f}점 (이익으로 가른 값 포함)")
    cfg = to_config(sc, best_plan)
    r = simulate(cfg, sc, baseline=False)
    report(f"  이익 {r['profit']:.1f}, 납기 {r['qcd']['delivery']['on_time']}/{len(sc['orders'])}, "
           f"직행률 {r['qcd']['quality']['first_pass_yield']:.2f}")
    for st in active_stations(sc):
        c = cfg["stations"][st["id"]]
        report(f"  {st['name']}: 인력 {c['crew']}, 공법 {c['method']}, 잔업 {c['overtime']}, 정비 {c['maintenance']}, 작업장 {c['units']}, 나눠 {c['split']}, 호이스트 {c['hoist']}, 여유 {c['buffer']}, 규칙 {c['dispatch']}")
    report(f"  자재 {cfg['materials']}, 직종별 인원 {cfg['pools']}, 트랜스포터 {cfg['transporters']['count']}대(정비 {cfg['transporters']['maintenance']}), 지게차 {cfg['forklifts']['count']}대(정비 {cfg['forklifts']['maintenance']}), 연구 {cfg['research']}, "
           f"발주 {cfg['ordering']}(여유 {cfg['jit_buffer']}일), 안전 재고 {cfg['safety_stock']}, 착수 간격 {best_plan['gap']}일")

    # 상위 설정에서 선택지 사용 비율
    top = [p for s, p in found if s >= best_score - 5]
    report(f"\n최고와 5점 안의 설정 {len(top)}개에서 고른 값 (공정 칸은 {len(sc['stations'])}공정을 합쳐 셈)")
    for kind in ("crew", "method", "overtime", "maintenance", "units", "split", "hoist", "buffer", "dispatch"):
        counts = Counter(p[f"{st['id']}.{kind}"] for p in top for st in active_stations(sc))
        report(f"  {kind:12s} " + ", ".join(f"{k}: {v}" for k, v in counts.most_common()))
    for name in [n for n in sp if n.startswith("material.") or n.startswith("pool.")] + ["research", "ordering", "jit_buffer"] + [n for n in sp if n.startswith("safety.")]:
        counts = Counter(p[name] for p in top)
        label = {"research": lambda k: "+".join(RESEARCH_SETS[k]) or "없음"}.get(name, str)
        report(f"  {name:12s} " + ", ".join(f"{label(k)}: {v}" for k, v in counts.most_common()))

    # 모든 공정을 한 값으로 고정했을 때의 최고 점수
    # 시작점은 상위 2개 설정(3.x는 5개). 고를 수 없는 공정(시운전 인력, 나눌 수 없는 공정)은 고정하지 않는다
    report("\n모든 공정을 한 값으로 고정했을 때의 최고 (최고와의 차이)")
    # 값은 공정마다 고를 수 있는 값을 모두 모은다(호이스트는 소조립·중조립에만 있다)
    cases = [(kind, v) for kind in ("crew", "method", "units", "split", "hoist", "buffer", "dispatch")
             for v in dict.fromkeys(v for st in active_stations(sc) for v in sp[f"{st['id']}.{kind}"])]
    tops = [p for _, p in found[:2]]
    jobs = []
    for kind, v in cases:
        fixed = {f"{st['id']}.{kind}": v for st in active_stations(sc) if v in sp[f"{st['id']}.{kind}"]}
        jobs += [({**p, **fixed}, fixed) for p in tops]
    # 공정 밖의 한 칸(발주 방식, 역산 여유일 4.13, 안전 재고 4.14)도 하나로 고정해 본다
    globals_ = [(name, v) for name in ["ordering", "jit_buffer"] + [n for n in sp if n.startswith("safety.")] if len(sp[name]) > 1 for v in sp[name]]
    for name, v in globals_:
        jobs += [({**p, name: v}, {name: v}) for p in tops]
    cases += globals_
    got_all = [score for score, _ in climbs(jobs)]
    forced = {}
    for k, (kind, v) in enumerate(cases):
        got = max(got_all[len(tops) * k:len(tops) * (k + 1)])
        forced[(kind, v)] = got
        report(f"  {kind} = {str(v):9s} {got:6.1f}점 ({got - best_score:+.1f})")
    report(f"\n실행 {runs}번, {time.time() - began:.0f}초")
    return {"best": best_score, "plan": best_plan, "forced": forced}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("scenario", nargs="?", choices=scenario_ids())
    parser.add_argument("-n", "--starts", type=int, default=10, help="무작위 시작점 수")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 1, help="프로세스 수(1이면 나누지 않음)")
    args = parser.parse_args()
    sids = [args.scenario] if args.scenario else scenario_ids()
    if args.jobs <= 1:
        for sid in sids:
            run(sid, args.starts, args.seed)
        return
    with ProcessPoolExecutor(args.jobs) as pool:
        for sid in sids:
            run(sid, args.starts, args.seed, pool=pool)


if __name__ == "__main__":
    main()
