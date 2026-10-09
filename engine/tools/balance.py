"""균형 점검(D15): "이것 하나만 고르면 끝"인 지배 전략이 없는지 숫자로 본다.

    cd engine && python -m tools.balance              # 두 시나리오 모두
    cd engine && python -m tools.balance growth -n 30  # 수주 증가, 시작점 30개

선택지 공간이 커서(공정마다 인력·공법·잔업·정비·작업장 수, 자재 등급, 인원, 연구, 발주, 착수 간격) 전수 대신
무작위 시작점에서 한 칸씩 바꿔 점수가 오르면 옮기는 언덕 오르기를 여러 번 한다. 결과로
  1. 찾은 최고 설정과 점수
  2. 상위 설정들에서 선택지별 사용 비율 (모든 상위 설정이 같은 값을 쓰면 그 선택이 지배적일 수 있다)
  3. "모든 공정을 X로 고정"했을 때의 최고 점수 (최고와 거의 같으면 그 X 하나로 끝나는 전략이다)
를 낸다. 엔진만 쓰고 결과는 화면에 찍기만 한다.
"""

from __future__ import annotations

import argparse
import copy
import random
from collections import Counter
from typing import Any, Callable

from shipyard.sim import load_scenario, scenario_ids, simulate

RESEARCH_SETS = [[], ["automation"], ["auto_inspect"], ["predictive"], ["automation", "auto_inspect"],
                 ["automation", "predictive"], ["auto_inspect", "predictive"], ["automation", "auto_inspect", "predictive"]]


def space(sc: dict[str, Any]) -> dict[str, list[Any]]:
    """바꿀 수 있는 칸과 그 값들. 공정 칸은 '<공정>.<항목>'이다."""
    rules = sc["rules"]
    # 분기가 열어 둔 옵션만 고른다(D33). options가 없으면 모두.
    opts = sc.get("options") or {"crews": list(rules["crews"]), "methods": list(rules["methods"]),
                                 "material_grades": list(sc["material_grades"]),
                                 "max_units": sc["expansion"]["max_units"], "split": True}
    out: dict[str, list[Any]] = {}
    for st in sc["stations"]:
        pid = st["id"]
        out[f"{pid}.crew"] = list(opts["crews"])
        out[f"{pid}.method"] = list(opts["methods"])
        out[f"{pid}.overtime"] = [False, True]
        out[f"{pid}.maintenance"] = [False, True]
        cap = sc["expansion"].get("max_units_by_station", {}).get(pid, opts["max_units"])
        out[f"{pid}.units"] = list(range(1, min(opts["max_units"], cap) + 1))
        out[f"{pid}.split"] = [False, True] if opts["split"] else [False]   # 나눠 하기(3.0). 탑재는 엔진이 나누지 않는다
    for m in sc["materials"]:
        out[f"material.{m['id']}"] = list(opts["material_grades"])
    out["pool"] = list(range(1, rules["max_pool"] + 1))
    out["transporters"] = list(range(1, sc["transporter"]["max_count"] + 1))
    out["tr_maintenance"] = [False, True]
    out["research"] = list(range(len(RESEARCH_SETS)))
    out["ordering"] = list(sc["ordering"])
    out["gap"] = [1, 2, 3, 4, 5, 6, 8]
    return out


def to_config(sc: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    """칸 값 묶음 → 엔진 설정. 우선순위는 납기순, 착수는 1일부터 gap일 간격."""
    by_due = sorted(sc["orders"], key=lambda o: (o["due_day"], o["id"]))
    return {
        "scenario": sc["id"],
        "ordering": plan["ordering"],
        "ships": {o["id"]: {"priority": k + 1, "start_day": min(sc["days"], 1 + k * plan["gap"])} for k, o in enumerate(by_due)},
        "stations": {st["id"]: {key: plan[f"{st['id']}.{key}"] for key in ("crew", "method", "overtime", "maintenance", "units", "split")}
                     for st in sc["stations"]},
        "materials": {m["id"]: plan[f"material.{m['id']}"] for m in sc["materials"]},
        "pool": plan["pool"],
        "transporters": {"count": plan["transporters"], "maintenance": plan["tr_maintenance"]},
        "research": RESEARCH_SETS[plan["research"]],
        "skilled_station": None,
    }


def score(sc: dict[str, Any], plan: dict[str, Any]) -> float:
    """등급 점수. 점수는 이익 상한(목표의 1.3배)에서 멈추므로, 같은 점수끼리는 이익으로 가른다(이익 1,000 = 0.01점)."""
    r = simulate(to_config(sc, plan), sc, baseline=False)
    return r["grade"]["score"] + r["profit"] / 100_000


def climb(sc: dict[str, Any], sp: dict[str, list[Any]], start: dict[str, Any], fixed: dict[str, Any],
          cache: dict[tuple, float]) -> tuple[float, dict[str, Any]]:
    """한 칸씩 바꿔 보며 점수가 가장 많이 오르는 쪽으로 옮긴다. 더 오르지 않으면 멈춘다."""
    def value(plan: dict[str, Any]) -> float:
        key = tuple(sorted(plan.items()))
        if key not in cache:
            cache[key] = score(sc, plan)
        return cache[key]

    plan = {**start, **fixed}
    best = value(plan)
    while True:
        move = None
        for name, values in sp.items():
            if name in fixed:
                continue
            for v in values:
                if v == plan[name]:
                    continue
                trial = {**plan, name: v}
                got = value(trial)
                if got > best + 1e-9:
                    best, move = got, trial
        if move is None:
            return best, plan
        plan = move


def run(scenario_id: str, starts: int, seed: int, report: Callable[[str], None] = print) -> dict[str, Any]:
    sc = load_scenario(scenario_id)
    sp = space(sc)
    rng = random.Random(seed)
    cache: dict[tuple, float] = {}
    found = []
    for _ in range(starts):
        start = {name: rng.choice(values) for name, values in sp.items()}
        found.append(climb(sc, sp, start, {}, cache))
    found.sort(key=lambda r: -r[0])
    best_score, best_plan = found[0]

    report(f"\n=== {sc['name']} ({len(sc['orders'])}척): 시작점 {starts}개, 실행 {len(cache)}번 ===")
    report(f"최고 {best_score:.1f}점 (이익으로 가른 값 포함)")
    cfg = to_config(sc, best_plan)
    r = simulate(cfg, sc, baseline=False)
    report(f"  이익 {r['profit']:.1f}, 납기 {r['qcd']['delivery']['on_time']}/{len(sc['orders'])}, "
           f"직행률 {r['qcd']['quality']['first_pass_yield']:.2f}")
    for st in sc["stations"]:
        c = cfg["stations"][st["id"]]
        report(f"  {st['name']}: 인력 {c['crew']}, 공법 {c['method']}, 잔업 {c['overtime']}, 정비 {c['maintenance']}, 작업장 {c['units']}, 나눠 {c['split']}")
    report(f"  자재 {cfg['materials']}, 인원 {cfg['pool']}, 트랜스포터 {cfg['transporters']}, 연구 {cfg['research']}, "
           f"발주 {cfg['ordering']}, 착수 간격 {best_plan['gap']}일")

    # 상위 설정에서 선택지 사용 비율
    top = [p for s, p in found if s >= best_score - 5]
    report(f"\n최고와 5점 안의 설정 {len(top)}개에서 고른 값 (공정 칸은 4공정을 합쳐 셈)")
    for kind in ("crew", "method", "overtime", "maintenance", "units", "split"):
        counts = Counter(p[f"{st['id']}.{kind}"] for p in top for st in sc["stations"])
        report(f"  {kind:12s} " + ", ".join(f"{k}: {v}" for k, v in counts.most_common()))
    for name in ("material.paper", "material.paint", "material.flag", "pool", "research", "ordering"):
        counts = Counter(p[name] for p in top)
        label = {"research": lambda k: "+".join(RESEARCH_SETS[k]) or "없음"}.get(name, str)
        report(f"  {name:12s} " + ", ".join(f"{label(k)}: {v}" for k, v in counts.most_common()))

    # 모든 공정을 한 값으로 고정했을 때의 최고 점수
    report("\n모든 공정을 한 값으로 고정했을 때의 최고 (최고와의 차이)")
    forced = {}
    for kind in ("crew", "method", "units", "split"):
        for v in sp[f"{sc['stations'][0]['id']}.{kind}"]:
            fixed = {f"{st['id']}.{kind}": v for st in sc["stations"]}
            got = max(climb(sc, sp, {**p, **fixed}, fixed, cache)[0] for _, p in found[:5])
            forced[(kind, v)] = got
            report(f"  {kind} = {str(v):9s} {got:6.1f}점 ({got - best_score:+.1f})")
    return {"best": best_score, "plan": best_plan, "forced": forced}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("scenario", nargs="?", choices=scenario_ids())
    parser.add_argument("-n", "--starts", type=int, default=20, help="무작위 시작점 수")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    for sid in [args.scenario] if args.scenario else scenario_ids():
        run(sid, args.starts, args.seed)


if __name__ == "__main__":
    main()
