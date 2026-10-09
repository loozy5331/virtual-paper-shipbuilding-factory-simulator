"""종이배 조선소 시뮬레이션 엔진.

규칙 문서의 "하루 진행 순서"를 그대로 옮긴 순수 함수다.
설정(dict)을 넣으면 60일치 기록과 레포트 값(dict)이 나온다.
표준 라이브러리만 쓰고, 화면이나 서버를 전혀 모른다.

    from shipyard import simulate, load_presets
    result = simulate(load_presets()[1]["config"])
    print(result["qcd"], result["profit"], result["grade"]["grade"])
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent / "data"

# 배의 하루 상태. 리드타임 분해에 쓰는 것은 착수 전과 인도 후를 뺀 아홉 개다.
WORK = "work"                        # 작업
REWORK = "rework"                    # 재작업
MATERIAL_WAIT = "material_wait"      # 자재 대기
STATION_WAIT = "station_wait"        # 작업장 대기 (앞 배가 작업장을 쓰는 중)
LABOR_WAIT = "labor_wait"            # 인력 대기 (로트는 들어왔는데 배정할 사람이 없음)
TRANSPORT = "transport"              # 운반 중 (손실 아님)
TRANSPORT_WAIT = "transport_wait"    # 운반 대기 (트랜스포터가 다른 로트를 나르거나 고장)
ACCIDENT_STOP = "accident_stop"      # 사고 중지
BREAKDOWN_STOP = "breakdown_stop"    # 설비 고장 중지
NOT_STARTED = "not_started"          # 착수 전
DONE = "done"                        # 인도 후
LEAD_TIME_STATES = [WORK, REWORK, MATERIAL_WAIT, STATION_WAIT, LABOR_WAIT,
                    TRANSPORT, TRANSPORT_WAIT, ACCIDENT_STOP, BREAKDOWN_STOP]
LOSS_STATES = [s for s in LEAD_TIME_STATES if s not in (WORK, TRANSPORT)]

# 나눠 하기(3.0): 한 배의 작업량을 빈 작업장 여러 곳에 나눌 때, 먼저 끝난 부분이 나머지를 기다리는 상태.
# 배의 하루 상태가 아니라 부분(parts) 기록에만 쓴다. 배는 부분 하나라도 일하면 작업이다.
PAIR_WAIT = "pair_wait"
MAX_PARTS = 3

COST_KEYS = ["labor", "overtime", "maintenance", "material", "holding", "wip", "rework",
             "accident", "breakdown", "transporter", "investment", "research", "late_penalty"]

EPS = 1e-9


def _is_int(value: Any) -> bool:
    return type(value) is int   # True/False는 정수로 치지 않는다


class ConfigError(ValueError):
    """설정이 규칙에 맞지 않을 때. messages에 사람이 읽을 이유가 들어 있다."""

    def __init__(self, messages: list[str]):
        super().__init__("; ".join(messages))
        self.messages = messages


# ---------------------------------------------------------------------------
# 데이터
# ---------------------------------------------------------------------------

DEFAULT_SCENARIO = "basic"   # 시나리오를 적지 않은 설정(1.x)은 기본 분기로 돈다.


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def scenario_ids() -> list[str]:
    """고를 수 있는 시나리오. 난이도(level) 순: 옛 분기가 쉽고 나중 분기가 어렵다."""
    level = {p.stem: _read(p).get("level", 0) for p in (DATA_DIR / "scenarios").glob("*.json")}
    return sorted(level, key=lambda sid: (level[sid], sid))


def list_scenarios() -> list[dict[str, Any]]:
    """첫 화면(책상 위 클립보드)과 분기 고르기용 요약. 난이도 순."""
    rules = _read(DATA_DIR / "rules.json")
    out = []
    for sid in scenario_ids():
        sc = _read(DATA_DIR / "scenarios" / f"{sid}.json")
        mix: dict[str, int] = {}
        for o in sc["orders"]:
            name = rules["ship_types"][o["type"]]["name"]
            mix[name] = mix.get(name, 0) + 1
        out.append({"id": sid, "name": sc["name"], "summary": sc["summary"], "period": sc["period"],
                    "level": sc.get("level", 0), "ships": len(sc["orders"]), "ship_mix": mix,
                    "kpi": sc["kpi"], "days": sc["days"]})
    return out


def load_scenario(scenario_id: str = DEFAULT_SCENARIO) -> dict[str, Any]:
    """규칙의 모든 숫자: 공통 규칙(rules.json)에 시나리오(수주, 기간, 목표, 품질 난수)를 얹는다."""
    if scenario_id not in scenario_ids():
        raise ConfigError([f"시나리오는 {', '.join(scenario_ids())} 중 하나여야 합니다"])
    rules = _read(DATA_DIR / "rules.json")
    rules.pop("_comment", None)
    sc = _read(DATA_DIR / "scenarios" / f"{scenario_id}.json")
    sc.pop("presets")
    random = {**rules.pop("random"), **sc.pop("random")}
    return {**sc, **rules, "random": random}


def load_presets(scenario_id: str = DEFAULT_SCENARIO) -> list[dict[str, Any]]:
    """시나리오의 프리셋 3개 (무관리, 관리, 전부 최대 투입)."""
    if scenario_id not in scenario_ids():
        raise ConfigError([f"시나리오는 {', '.join(scenario_ids())} 중 하나여야 합니다"])
    return _read(DATA_DIR / "scenarios" / f"{scenario_id}.json")["presets"]


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    """3.0 설정(`areas`)을 엔진이 읽는 모양(`stations`)으로 바꾼다. 2.x·1.x 설정은 그대로 돌려준다.

    areas.<공정> = {stations: 작업장 수 1~3, crew, method, overtime, maintenance, split}.
    4M은 공정마다 하나이고 그 공정의 모든 작업장에 같게 적용한다(D30).
    """
    if not isinstance(config, dict) or not isinstance(config.get("areas"), dict):
        return config
    out = {k: v for k, v in config.items() if k != "areas"}
    stations = {}
    for pid, area in config["areas"].items():
        if not isinstance(area, dict):
            stations[pid] = area
            continue
        st = {k: v for k, v in area.items() if k != "stations"}
        st["units"] = area.get("stations", 1)
        stations[pid] = st
    out["stations"] = stations
    return out


def scenario_of(config: dict[str, Any]) -> dict[str, Any]:
    """설정이 고른 시나리오. 적지 않았으면 기본 분기."""
    sid = config.get("scenario", DEFAULT_SCENARIO) if isinstance(config, dict) else DEFAULT_SCENARIO
    if not isinstance(sid, str):
        raise ConfigError([f"시나리오는 {', '.join(scenario_ids())} 중 하나여야 합니다"])
    return load_scenario(sid)


# ---------------------------------------------------------------------------
# 설정 검사
# ---------------------------------------------------------------------------

def validate_config(config: dict[str, Any], scenario: dict[str, Any]) -> None:
    """설정이 4장의 선택지 안에 있는지 확인한다. 틀리면 ConfigError."""
    errors: list[str] = []
    if config.get("scenario") not in (None, scenario.get("id")):
        errors.append(f"설정의 시나리오({config.get('scenario')})와 돌리려는 시나리오({scenario.get('id')})가 다릅니다")
    days = scenario["days"]
    rules = scenario["rules"]
    order_ids = [o["id"] for o in scenario["orders"]]
    station_ids = [s["id"] for s in scenario["stations"]]
    material_ids = [m["id"] for m in scenario["materials"]]

    ships = config.get("ships") or {}
    for sid in order_ids:
        ship = ships.get(sid)
        if ship is None:
            errors.append(f"{sid}: 설정이 없습니다")
            continue
        start = ship.get("start_day")
        if not _is_int(start) or not 1 <= start <= days:
            errors.append(f"{sid}: 착수 예정일은 1~{days} 사이의 정수여야 합니다")
        for mid in material_ids:
            day = (ship.get("order_days") or {}).get(mid)
            if day is not None and (not _is_int(day) or not 1 <= day <= days):
                errors.append(f"{sid}: {mid} 발주일은 1~{days} 사이의 정수이거나 비워 둬야 합니다")
    priorities = [ships[sid].get("priority") for sid in order_ids if sid in ships]
    if sorted(p for p in priorities if _is_int(p)) != list(range(1, len(order_ids) + 1)):
        errors.append(f"우선순위는 1~{len(order_ids)}를 한 번씩 써야 합니다")

    stations = config.get("stations") or {}
    for pid in station_ids:
        st = stations.get(pid)
        if st is None:
            errors.append(f"{pid}: 설정이 없습니다")
            continue
        if st.get("method") not in rules["methods"]:
            errors.append(f"{pid}: 공법은 {', '.join(rules['methods'])} 중 하나여야 합니다")
        for key in ("overtime", "maintenance"):
            if not isinstance(st.get(key), bool):
                errors.append(f"{pid}: {key}는 true 또는 false여야 합니다")
        if st.get("crew", "normal") not in rules["crews"]:
            errors.append(f"{pid}: 인력은 {', '.join(rules['crews'])} 중 하나여야 합니다")
        if not isinstance(st.get("split", False), bool):
            errors.append(f"{pid}: 나눠 하기(split)는 true 또는 false여야 합니다")
        units = st.get("units", 1)
        max_units = scenario["expansion"]["max_units"]
        if not _is_int(units) or not 1 <= units <= max_units:
            errors.append(f"{pid}: 작업장 수는 1~{max_units}개여야 합니다")

    pool = config.get("pool")
    if not _is_int(pool) or not 1 <= pool <= rules["max_pool"]:
        errors.append(f"작업대기소 인원은 1~{rules['max_pool']}명이어야 합니다")

    tr = config.get("transporters") or {}
    max_tr = scenario["transporter"]["max_count"]
    if not _is_int(tr.get("count")) or not 1 <= tr["count"] <= max_tr:
        errors.append(f"트랜스포터는 1~{max_tr}대여야 합니다")
    if not isinstance(tr.get("maintenance"), bool):
        errors.append("트랜스포터 정비는 true 또는 false여야 합니다")

    queue = config.get("research", [])
    if not isinstance(queue, list) or any(r not in scenario["research"] for r in queue):
        errors.append(f"연구는 {', '.join(scenario['research'])} 중에서 골라야 합니다")
    elif len(set(queue)) != len(queue):
        errors.append("같은 연구를 두 번 넣을 수 없습니다")

    ordering = config.get("ordering")
    if ordering is not None and ordering not in scenario["ordering"]:
        errors.append(f"발주 방식은 {', '.join(scenario['ordering'])} 중 하나이거나 비워 둬야 합니다")

    skilled = config.get("skilled_station")
    if skilled is not None and skilled not in station_ids:
        errors.append("시니어는 공정 하나에 두거나 미배치(null)여야 합니다")

    grades = config.get("materials") or {}
    if not isinstance(grades, dict) or any(m not in material_ids or g not in scenario["material_grades"]
                                           for m, g in grades.items()):
        errors.append(f"자재 등급은 자재마다 {', '.join(scenario['material_grades'])} 중 하나여야 합니다")

    if not errors:
        errors += _locked_options(config, scenario)
    if errors:
        raise ConfigError(errors)


def _locked_options(config: dict[str, Any], scenario: dict[str, Any]) -> list[str]:
    """분기(난이도)가 열어 둔 옵션만 썼는지(D33). 화면이 숨긴 옵션을 설정 JSON으로 보내도 여기서 막는다.

    시나리오 파일의 options: crews·methods·material_grades(쓸 수 있는 값), max_units(작업장 수 상한), split(나눠 하기).
    options가 없는 시나리오(손 계산용 등)는 모두 열려 있다.
    """
    opts = scenario.get("options")
    if not opts:
        return []
    name = scenario.get("name", "이 분기")
    rules = scenario["rules"]
    errors: list[str] = []
    for st in scenario["stations"]:
        pid, label = st["id"], st["name"]
        cfg = config["stations"][pid]
        crew = crew_of(config, pid)
        if crew not in opts["crews"]:
            errors.append(f"{name}에서는 인력 '{rules['crews'][crew]['name']}'을(를) 쓸 수 없습니다({label})")
        if cfg["method"] not in opts["methods"]:
            errors.append(f"{name}에서는 공법 '{rules['methods'][cfg['method']]['name']}'을(를) 쓸 수 없습니다({label})")
        if cfg.get("units", 1) > opts["max_units"]:
            errors.append(f"{name}에서는 작업장을 {opts['max_units']}개까지 둘 수 있습니다({label})")
        if cfg.get("split", False) and not opts["split"]:
            errors.append(f"{name}에서는 나눠 하기를 쓸 수 없습니다({label})")
    for mid, grade in (config.get("materials") or {}).items():
        if grade not in opts["material_grades"]:
            errors.append(f"{name}에서는 자재 등급 '{scenario['material_grades'][grade]['name']}'을(를) 쓸 수 없습니다({mid})")
    return errors


# ---------------------------------------------------------------------------
# 계산식 (3장, 5장)
# ---------------------------------------------------------------------------

def crew_of(config: dict[str, Any], station_id: str) -> str:
    """공정의 인력: normal, skilled, robot. 1.x 설정의 시니어(skilled_station)는 그 공정의 숙련공으로 읽는다."""
    crew = config["stations"][station_id].get("crew")
    if crew is not None:
        return crew
    return "skilled" if config.get("skilled_station") == station_id else "normal"


def material_grade(config: dict[str, Any], material_id: str | None) -> str:
    """자재 등급: standard(표준) 또는 cheap(저가). 설정에 없으면 표준."""
    return (config.get("materials") or {}).get(material_id, "standard") if material_id else "standard"


def is_overtime(station_cfg: dict[str, Any]) -> bool:
    """잔업은 사람이 하는 일이다. 로봇 공정은 잔업을 켜도 하지 않는다."""
    return station_cfg["overtime"] and station_cfg.get("crew") != "robot"


def station_rate(station_cfg: dict[str, Any], rules: dict[str, Any], assigned: int, worker_factor: float = 1) -> float:
    """하루 처리량 = min(배정 인원 × 자동화 배수, 설비 수용 인원) × 공법 속도 × 잔업 계수. 로봇은 정해진 인원분."""
    speed = rules["methods"][station_cfg["method"]]["speed"]
    if station_cfg.get("crew") == "robot":
        return rules["crews"]["robot"]["rate"] * speed
    workers = min(assigned * worker_factor, rules["max_workers_per_station"])
    overtime = rules["overtime"]["speed"] if is_overtime(station_cfg) else 1.0
    return workers * speed * overtime


def station_defect_rate(station_cfg: dict[str, Any], crew: str, scenario: dict[str, Any],
                        research: frozenset[str] = frozenset(), lots_done: int = 0, grade: str = "standard") -> float:
    """불량률 = 공법(신공법은 끝낸 로트 수만큼 낮아짐) + 잔업 + 미정비 + 인력 + 자재 등급 − 자동 검사.

    예지 정비는 고장만 막는다(2.0). 정비를 안 한 공정의 불량 가산은 그대로다.

    research는 효과가 난 연구, lots_done은 이 공정에서 검사를 마친 로트 수(학습 곡선)."""
    rules = scenario["rules"]
    method = rules["methods"][station_cfg["method"]]
    rate = method["defect_rate"]
    if "learning_step" in method:
        rate = max(method["defect_floor"], rate - method["learning_step"] * lots_done)
    if is_overtime({**station_cfg, "crew": crew}):
        rate += rules["overtime"]["defect_add"]
    if not station_cfg["maintenance"]:
        rate += rules["no_maintenance_defect_add"]
    rate += rules["crews"][crew].get("defect_add", 0)
    rate += scenario["material_grades"][grade]["defect_add"]
    if "auto_inspect" in research:
        rate -= scenario["research"]["auto_inspect"]["defect_sub"]
    return round(max(0.0, rate), 6)


def max_rate(rules: dict[str, Any]) -> float:
    """작업장이 낼 수 있는 최대 처리량. OEE 성능가동률의 기준이다."""
    top_speed = max(m["speed"] for m in rules["methods"].values())
    return rules["max_workers_per_station"] * top_speed * rules["overtime"]["speed"]


def research_schedule(queue: list[str], scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """연구 대기열을 1일부터 하나씩 진행한다. 효과는 끝난 다음 날부터."""
    out = []
    day = 1
    for rid in queue:
        info = scenario["research"][rid]
        end = day + info["days"] - 1
        out.append({"id": rid, "name": info["name"], "cost": info["cost"], "start": day, "end": end,
                    "effective_from": end + 1, "done": end <= scenario["days"]})
        day = end + 1
    return out


def station_units(config: dict[str, Any], scenario: dict[str, Any]) -> list[int]:
    """공정마다 작업장 수. 설정에 없으면 1개(1.x 설정)."""
    return [config["stations"][s["id"]].get("units", 1) for s in scenario["stations"]]


def split_parts(config: dict[str, Any], scenario: dict[str, Any], p: int, units: int) -> int:
    """나눠 하기를 켠 공정에서 배 한 척을 나눌 최대 부분 수. 탑재(마지막 공정)는 나누지 않는다."""
    st = scenario["stations"][p]
    if p == len(scenario["stations"]) - 1 or not config["stations"][st["id"]].get("split", False):
        return 1
    return min(units, MAX_PARTS)


def investment(config: dict[str, Any], scenario: dict[str, Any]) -> float:
    """설비 투자비: 증설한 작업장 + 로봇 도입(작업장마다) + 신공법 도입(공정마다)."""
    rules = scenario["rules"]
    total = 0.0
    for st, n in zip(scenario["stations"], station_units(config, scenario)):
        cfg = config["stations"][st["id"]]
        total += (n - 1) * scenario["expansion"]["cost"][st["id"]]
        if crew_of(config, st["id"]) == "robot":
            total += n * rules["crews"]["robot"]["install_cost"]
        total += rules["methods"][cfg["method"]].get("setup_cost", 0)
    return total


def material_prices(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, float]:
    """자재 단가. 저가 등급은 단가 × price_factor."""
    return {m["id"]: m["price"] * scenario["material_grades"][material_grade(config, m["id"])]["price_factor"]
            for m in scenario["materials"]}


def fixed_costs(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, float]:
    """실행 전에 정해지는 비용: 인건비(대기소), 정비비(작업장마다), 트랜스포터, 설비 투자비, 연구비."""
    costs = scenario["rules"]["costs"]
    tr = scenario["transporter"]
    days = scenario["days"]
    n_tr = config["transporters"]["count"]
    units = station_units(config, scenario)
    return {
        "labor": config["pool"] * costs["wage_per_day"] * days,
        "maintenance": sum(n for s, n in zip(scenario["stations"], units) if config["stations"][s["id"]]["maintenance"])
        * costs["maintenance_per_station"],
        "transporter": n_tr * tr["cost_per_day"] * days
        + (n_tr * tr["maintenance_cost"] if config["transporters"]["maintenance"] else 0),
        "investment": investment(config, scenario),
        "research": sum(scenario["research"][r]["cost"] for r in config.get("research", [])),
    }


def preview(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, Any]:
    """실행하지 않고 설정만으로 알 수 있는 값: 공정별 최대 처리량과 불량률, 고정비, 연구 일정."""
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    validate_config(config, scenario)
    order_days = resolve_order_days(config, scenario)
    rules = scenario["rules"]
    every = frozenset(config.get("research", []))
    stations = {}
    for st in scenario["stations"]:
        cfg = config["stations"][st["id"]]
        crew = crew_of(config, st["id"])
        grade = material_grade(config, st["material"])
        cfg = {**cfg, "crew": crew}
        stations[st["id"]] = {
            "rate": station_rate(cfg, rules, rules["max_workers_per_station"]),
            "defect_rate": station_defect_rate(cfg, crew, scenario, grade=grade),
            "defect_rate_final": station_defect_rate(cfg, crew, scenario, every, lots_done=len(scenario["orders"]), grade=grade),
        }
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    materials = {sid: {mid: {"order_day": day, "arrival_day": None if day is None else day + lead[mid]}
                       for mid, day in days.items()}
                 for sid, days in order_days.items()}
    return {"stations": stations, "fixed_costs": fixed_costs(config, scenario),
            "research": research_schedule(config.get("research", []), scenario),
            "materials": materials, "plan": plan_schedule(config, scenario)}


def plan_schedule(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """계획 막대: 배마다 착수일부터 공정을 이어 붙인 일정과, 같은 작업장을 두 배가 겹쳐 쓰는 구간.

    배가 작업장과 사람을 혼자 쓰고 자재·설비가 멈추지 않는다고 본 일정이다(소요일 = 작업량 ÷ 처리량 올림,
    공정 사이는 운반일). 실제 실행에서는 겹친 구간만큼 뒤 순위 배가 작업장 대기를 한다.
    """
    rules = scenario["rules"]
    tr = scenario["transporter"]
    move_days = math.ceil(tr["lot_weight"] / (tr["capacity"] * config["transporters"]["count"]))
    assigned = min(config["pool"], rules["max_workers_per_station"])
    units_of = dict(zip((s["id"] for s in scenario["stations"]), station_units(config, scenario)))
    parts_of = {s["id"]: split_parts(config, scenario, p, units_of[s["id"]]) for p, s in enumerate(scenario["stations"])}
    ships: dict[str, dict[str, dict[str, int]]] = {}
    for order in scenario["orders"]:
        work = scenario["ship_types"][order["type"]]["work"]
        day = config["ships"][order["id"]]["start_day"]
        spans = {}
        for st in scenario["stations"]:
            rate = station_rate(config["stations"][st["id"]], rules, assigned)
            # 나눠 하기: 작업장을 모두 쓴다고 보고 부분 작업량으로 잰다(배가 혼자 쓸 때의 일정).
            end = day + math.ceil(work[st["id"]] / parts_of[st["id"]] / rate - EPS) - 1
            spans[st["id"]] = {"start": day, "end": end}
            day = end + move_days   # 끝난 다음 날부터 운반, 다 나른 날 다음 공정에 들어간다.
        ships[order["id"]] = spans

    # 겹침: 같은 공정을 쓰는 배가 그 공정의 작업장 수보다 많은 날. 두 배씩 묶어 그 날들의 구간으로 적는다.
    conflicts = []
    ids = list(ships)
    for st, n_units in zip(scenario["stations"], station_units(config, scenario)):
        sid = st["id"]
        # 나눠 하기를 켠 공정은 배 한 척이 작업장을 모두 차지한다.
        users = lambda day: sum(parts_of[sid] for k in ids if ships[k][sid]["start"] <= day <= ships[k][sid]["end"])
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                sa, sb = ships[a][sid], ships[b][sid]
                run_start = None
                for day in range(max(sa["start"], sb["start"]), min(sa["end"], sb["end"]) + 2):
                    over = day <= min(sa["end"], sb["end"]) and users(day) > n_units
                    if over and run_start is None:
                        run_start = day
                    elif not over and run_start is not None:
                        conflicts.append({"station": sid, "ships": [a, b], "start": run_start, "end": day - 1})
                        run_start = None
    return {"ships": ships, "conflicts": conflicts}


# ---------------------------------------------------------------------------
# 시뮬레이션 (9장)
# ---------------------------------------------------------------------------

def simulate(config: dict[str, Any], scenario: dict[str, Any] | None = None, baseline: bool = True) -> dict[str, Any]:
    """설정으로 시나리오 기간 전체를 돌리고 기록, 레포트 값, 등급을 돌려준다.

    같은 설정이면 항상 같은 결과가 나온다. 난수는 시나리오의 표에서 읽는다.
    baseline이 참이면 기준선 프리셋(전부 최대 투입)도 같은 시나리오로 돌려 등급에 비교를 붙인다.
    """
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    result = _run(_with_order_days(config, scenario), scenario)
    base_cfg = _baseline_config(scenario) if baseline else None
    base = _run(_with_order_days(base_cfg, scenario), scenario) if base_cfg is not None else None
    result["grade"] = _grade(result, config, base, base_cfg, scenario)
    return result


def _baseline_config(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """기준선 프리셋 설정. 시나리오의 배가 프리셋과 다르면(손 계산용 시나리오 등) 없다."""
    pid = scenario["grade"]["baseline_preset"]
    preset = next((p for p in load_presets(scenario.get("id", DEFAULT_SCENARIO)) if p["id"] == pid), None)
    if preset is None:
        return None
    if set(preset["config"]["ships"]) != {o["id"] for o in scenario["orders"]}:
        return None
    return preset["config"]


def _run(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    config = normalize_config(config)
    validate_config(config, scenario)

    days: int = scenario["days"]
    rules = scenario["rules"]
    costs = rules["costs"]
    ot = rules["overtime"]
    bd = scenario["breakdown"]
    tr = scenario["transporter"]
    rnd = scenario["random"]
    orders = scenario["orders"]
    stations = scenario["stations"]
    materials = {m["id"]: m for m in scenario["materials"]}
    types = scenario["ship_types"]
    n_ships, n_st = len(orders), len(stations)

    crews = [crew_of(config, s["id"]) for s in stations]
    st_cfg = [{**config["stations"][s["id"]], "crew": c} for s, c in zip(stations, crews)]
    grades = [material_grade(config, s["material"]) for s in stations]
    prices = material_prices(config, scenario)
    skilled_extra = rules["crews"]["skilled"]["extra_wage_per_worker_day"]
    n_units = station_units(config, scenario)              # 공정마다 작업장 수 (증설하면 2~3)
    parts_max = [split_parts(config, scenario, p, n_units[p]) for p in range(n_st)]   # 나눠 하기: 배 한 척의 최대 부분 수
    pool: int = config["pool"]
    n_tr: int = config["transporters"]["count"]
    tr_maintained: bool = config["transporters"]["maintenance"]
    schedule = research_schedule(config.get("research", []), scenario)
    automation = scenario["research"]["automation"]

    def work_of(ship: int, p: int) -> float:
        return types[orders[ship]["type"]]["work"][stations[p]["id"]]

    def bom_of(ship: int, material: str) -> int:
        return types[orders[ship]["type"]]["bom"].get(material, 0)

    # 우선순위 숫자가 작은 배부터 본다. 운반, 투입, 인원 배정이 모두 이 순서다.
    priority = [config["ships"][o["id"]]["priority"] for o in orders]
    by_priority = sorted(range(n_ships), key=lambda i: priority[i])

    # 입고 일정: 발주일 + 리드타임 = 입고일.
    # order_days는 결과에 싣는 배별 발주일(필요 없는 자재와 비운 칸은 뺀다).
    arrivals: dict[int, list[tuple[str, int, str]]] = {}
    order_days: list[dict[str, int]] = [{} for _ in orders]
    for i, order in enumerate(orders):
        for mid, day in (config["ships"][order["id"]].get("order_days") or {}).items():
            qty = bom_of(i, mid)
            if day is None or qty == 0:
                continue
            order_days[i][mid] = day
            arrivals.setdefault(day + materials[mid]["lead_days"], []).append((mid, qty, order["id"]))

    stock = {mid: scenario.get("initial_stock", {}).get(mid, 0) for mid in materials}
    stage = [0] * n_ships                                  # 다음에 들어갈 공정
    ready = [config["ships"][o["id"]]["start_day"] for o in orders]   # 그 공정에 들어갈 수 있는 첫날
    started: list[int | None] = [None] * n_ships           # 소조립에 들어간 날
    delivered: list[int | None] = [None] * n_ships
    # 작업장 단위 상태는 [공정][작업장 번호]. 작업장 하나에 로트 하나다.
    current: list[list[dict[str, Any] | None]] = [[None] * n for n in n_units]   # 작업장에 들어가 있는 로트
    stop_until = [[0] * n for n in n_units]
    stop_cause = [[ACCIDENT_STOP] * n for n in n_units]
    overtime_days = [[0] * n for n in n_units]
    unit_busy = [[0] * n for n in n_units]                 # 작업장마다 일한 날 (고장 판정 간격)
    unit_breakdowns = [[0] * n for n in n_units]
    transit: dict[int, dict[str, Any]] = {}                # 공정 사이를 옮기는 로트
    # 공정 안에 있는 배의 묶음: 부분(작업장) 수, 남은 부분, 끝난 작업장, 검사 판정. 나눠 하기를 끄면 부분 1개.
    groups: dict[int, dict[str, Any]] = {}
    tr_moves = [0] * n_tr
    tr_stop_until = [0] * n_tr

    ship_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_ships)]
    station_daily: list[list[list[dict[str, Any]]]] = [[[] for _ in range(n)] for n in n_units]
    transporter_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_tr)]
    workforce_daily: list[dict[str, int]] = []
    spans: list[dict[str, dict[str, int]]] = [{} for _ in range(n_ships)]
    inventory_daily: list[dict[str, int]] = []
    inventory_value_daily: list[float] = []            # 그날 작업이 끝난 뒤 창고 재고 금액 (재고비의 기준)
    events: list[dict[str, Any]] = []

    busy = [0] * n_st
    accident_stopped = [0] * n_st
    breakdown_stopped = [0] * n_st
    material_wait = [0] * n_st
    labor_wait = [0] * n_st
    work_done = [0.0] * n_st
    inspections = [0] * n_st
    passes = [0] * n_st
    station_breakdowns = [0] * n_st
    tr_breakdowns = [0] * n_tr
    accidents = 0
    defects = 0
    man_days = 0

    cost = {k: 0.0 for k in COST_KEYS}

    for day in range(1, days + 1):
        done_research = frozenset(r["id"] for r in schedule if r["end"] < day)
        ship_state: dict[int, tuple[str, int, int | None]] = {}   # 배 → (상태, 공정, 작업장 번호)
        closed_today: dict[int, dict[str, Any]] = {}             # 오늘 공정을 끝낸 묶음(하루 기록의 parts용)

        def put(i: int, entry: tuple[str, int, int | None]) -> None:
            """배의 오늘 상태. 부분 하나라도 일하면 작업(재작업)이고, 다른 부분의 대기·중지로 덮지 않는다."""
            old = ship_state.get(i)
            if old and old[0] in (WORK, REWORK) and entry[0] not in (WORK, REWORK):
                return
            ship_state[i] = entry
        station_today = [[{"state": "idle", "ship": None, "workers": 0} for _ in range(n)] for n in n_units]

        # 1. 입고
        for mid, qty, for_ship in arrivals.get(day, []):
            stock[mid] += qty
            events.append({"day": day, "type": "arrival", "material": mid, "quantity": qty, "ship": for_ship})

        # 2. 운반: 공정을 끝낸 다음 날부터 우선순위 순으로 나른다.
        #    트랜스포터 한 대는 하루에 capacity만큼 나르고, 로트를 다 나른 날 바로 다음 공정에 들어갈 수 있다.
        free = [k for k in range(n_tr) if day > tr_stop_until[k]]
        room = {k: float(tr["capacity"]) for k in free}
        carried: dict[int, list[str]] = {k: [] for k in free}
        for i in by_priority:
            lot = transit.get(i)
            if lot is None or lot["since"] >= day:
                continue
            route = {"ship": orders[i]["id"], "from": stations[lot["from"]]["id"], "to": stations[lot["from"] + 1]["id"]}
            took = False
            for k in free:
                take = min(room[k], lot["left"])
                if take <= EPS:
                    continue
                if not lot["moving"]:
                    lot["moving"] = True
                    events.append({"day": day, "type": "transport_start", **route})
                room[k] -= take
                lot["left"] -= take
                carried[k].append(orders[i]["id"])
                took = True
                if lot["left"] <= EPS:
                    break
            if lot["left"] <= EPS:
                del transit[i]
                ready[i] = day
                events.append({"day": day, "type": "transport_end", **route})
            else:
                ship_state[i] = (TRANSPORT if took else TRANSPORT_WAIT, lot["from"], None)

        # 2-1. 오늘 운행한 트랜스포터는 운행 횟수를 세고, 정해진 간격마다 고장 판정을 한다.
        for k in range(n_tr):
            if k not in carried:
                transporter_daily[k].append({"state": BREAKDOWN_STOP, "ships": []})
                continue
            if not carried[k]:
                transporter_daily[k].append({"state": "idle", "ships": []})
                continue
            transporter_daily[k].append({"state": "move", "ships": carried[k]})
            tr_moves[k] += 1
            if tr_moves[k] % tr["every_moves"] == 0:
                threshold = 0 if "predictive" in done_research else (
                    tr["threshold_maintained"] if tr_maintained else tr["threshold"])
                table = rnd["transporter_breakdown"]
                n = tr_moves[k] // tr["every_moves"]
                if table[(n - 1) % len(table)] < threshold:
                    tr_stop_until[k] = day + tr["stop_days"]
                    cost["breakdown"] += tr["repair_cost"]
                    tr_breakdowns[k] += 1
                    events.append({"day": day, "type": "breakdown", "transporter": f"T{k + 1}"})

        # 3. 투입: 공정 순서대로, 작업장 번호 순서대로 본다. 비어 있으면 우선순위 순으로 들어올 로트를 찾는다.
        for p in range(n_st):
            pid = stations[p]["id"]
            inside = {c["ship"] for c in current[p] if c}
            waiting = [i for i in by_priority
                       if delivered[i] is None and i not in transit and stage[i] == p and ready[i] <= day
                       and i not in inside and i not in groups]
            entered: set[int] = set()
            stopped_causes = []

            for u in range(n_units[p]):
                cur = current[p][u]
                # 3-1. 사고나 고장으로 중지 중이면 건너뛴다.
                if day <= stop_until[p][u]:
                    cause = stop_cause[p][u]
                    stopped_causes.append(cause)
                    if cause == ACCIDENT_STOP:
                        accident_stopped[p] += 1
                    else:
                        breakdown_stopped[p] += 1
                    if cur:
                        put(cur["ship"], (cause, p, u))
                    station_today[p][u] = {"state": cause, "ship": orders[cur["ship"]]["id"] if cur else None, "workers": 0}
                    continue

                # 3-2. 비어 있으면 자재를 꺼내(출고) 로트를 들인다.
                if cur is None:
                    mid = stations[p]["material"]
                    for i in waiting:
                        if i in entered or ship_state.get(i, ("",))[0] == MATERIAL_WAIT:
                            continue
                        need = bom_of(i, mid) if mid else 0
                        if mid and stock[mid] < need:
                            ship_state[i] = (MATERIAL_WAIT, p, None)
                            continue
                        if mid:
                            stock[mid] -= need
                            events.append({"day": day, "type": "issue", "material": mid, "quantity": need,
                                           "ship": orders[i]["id"], "station": pid})
                        # 나눠 하기: 지금 비어 있고 멈추지 않은 작업장(이 작업장 + 뒤 번호)에 작업량을 똑같이 나눈다.
                        work = work_of(i, p)
                        parts = [u] + [v for v in range(u + 1, n_units[p])
                                       if current[p][v] is None and day > stop_until[p][v]][:parts_max[p] - 1]
                        k = len(parts)
                        group = groups[i] = {"station": p, "units": parts, "done": [], "left": k,
                                             "base": work / k, "verdict": None}
                        for idx, v in enumerate(parts):
                            current[p][v] = {"ship": i, "remaining": work / k, "amount": work / k, "rework": False,
                                             "group": group, "part": idx}
                            events.append({"day": day, "type": "enter", "ship": orders[i]["id"], "station": pid, "unit": v + 1})
                        cur = current[p][u]
                        entered.add(i)
                        spans[i][pid] = {"start": day, "end": day}
                        if p == 0:
                            started[i] = day
                        break
                    if cur is None and any(ship_state.get(i, ("",))[0] == MATERIAL_WAIT for i in waiting):
                        material_wait[p] += 1
                        station_today[p][u] = {"state": MATERIAL_WAIT, "ship": None, "workers": 0}

            # 못 들어간 로트: 모든 작업장이 중지 중이면 그 원인, 아니면 작업장 대기.
            all_stopped = len(stopped_causes) == n_units[p]
            for i in waiting:
                if i not in ship_state and i not in entered:
                    ship_state[i] = (stopped_causes[0], p, None) if all_stopped else (STATION_WAIT, p, None)

        # 4. 인원 배정: 로트가 있고 중지가 아닌 작업장에, 그 로트의 배 우선순위 순으로 사람을 보낸다.
        automated = "automation" in done_research
        need = automation["workers_needed"] if automated else rules["max_workers_per_station"]
        factor = automation["worker_factor"] if automated else 1
        idle = pool
        assigned = [[0] * n for n in n_units]
        for p, u in sorted(((p, u) for p in range(n_st) for u in range(n_units[p])
                            if current[p][u] and day > stop_until[p][u] and crews[p] != "robot"),
                           key=lambda pu: priority[current[pu[0]][pu[1]]["ship"]]):
            assigned[p][u] = min(need, idle)
            idle -= assigned[p][u]
        man_days += pool - idle
        workforce_daily.append({"assigned": pool - idle, "idle": idle})

        # 5. 작업: 남은 작업량에서 처리량을 뺀다. 오늘 들어온 로트도 오늘부터 작업한다.
        #    사고·고장 판정은 작업장마다 따로 센다. 난수표는 작업장 번호만큼 한 칸씩 밀어 읽는다(1호는 그대로).
        for p, u in ((p, u) for p in range(n_st) for u in range(n_units[p])):
            cur = current[p][u]
            if cur is None or day <= stop_until[p][u]:
                continue
            pid = stations[p]["id"]
            i = cur["ship"]
            if assigned[p][u] == 0 and crews[p] != "robot":
                labor_wait[p] += 1
                put(i, (LABOR_WAIT, p, u))
                station_today[p][u] = {"state": LABOR_WAIT, "ship": orders[i]["id"], "workers": 0}
                continue

            cur["remaining"] -= station_rate(st_cfg[p], rules, assigned[p][u], factor)
            if crews[p] == "skilled":
                cost["labor"] += assigned[p][u] * skilled_extra
            busy[p] += 1
            unit_busy[p][u] += 1
            state = REWORK if cur["rework"] else WORK
            put(i, (state, p, u))
            station_today[p][u] = {"state": state, "ship": orders[i]["id"], "workers": assigned[p][u]}
            spans[i][pid]["end"] = day

            # 5-1. 잔업일을 세고, 정해진 간격마다 사고 판정을 한다.
            if is_overtime(st_cfg[p]):
                overtime_days[p][u] += 1
                cost["overtime"] += assigned[p][u] * costs["wage_per_day"] * ot["pay_rate"]
                if overtime_days[p][u] % ot["accident_every_days"] == 0:
                    table = rnd["accident"][pid]
                    n = overtime_days[p][u] // ot["accident_every_days"]
                    if table[(n - 1 + u) % len(table)] < ot["accident_threshold"]:
                        stop_until[p][u] = day + ot["accident_stop_days"]
                        stop_cause[p][u] = ACCIDENT_STOP
                        cost["accident"] += costs["accident"]
                        accidents += 1
                        events.append({"day": day, "type": "accident", "station": pid, "unit": u + 1, "ship": orders[i]["id"]})

            # 5-2. 일한 날을 세고, 정해진 간격마다 고장 판정을 한다. 오늘 사고로 멈췄으면 판정하지 않는다.
            if unit_busy[p][u] % bd["every_busy_days"] == 0 and day > stop_until[p][u]:
                threshold = 0 if "predictive" in done_research else (
                    bd["threshold_maintained"] if st_cfg[p]["maintenance"] else bd["threshold"])
                table = rnd["breakdown"][pid]
                n = unit_busy[p][u] // bd["every_busy_days"]
                if table[(n - 1 + u) % len(table)] < threshold:
                    stop_until[p][u] = day + bd["stop_days"]
                    stop_cause[p][u] = BREAKDOWN_STOP
                    cost["breakdown"] += bd["cost"]
                    station_breakdowns[p] += 1
                    unit_breakdowns[p][u] += 1
                    events.append({"day": day, "type": "breakdown", "station": pid, "unit": u + 1, "ship": orders[i]["id"]})

            # 5-3. 다 끝났으면 검사하고, 불량이면 재작업량을 넣는다. 합격하면 다음 날부터 운반을 기다린다.
            #      나눠 한 배는 부분마다 끝나지만, 검사 판정은 배 한 척에 한 번이다(같은 난수, 같은 불량률).
            #      불량이면 부분마다 자기 작업량의 비율만큼 재작업한다. 재작업비·불량 건수·검사 수도 배 한 척에 한 번.
            if cur["remaining"] <= EPS:
                work_done[p] += cur["amount"]
                group = cur["group"]
                if not cur["rework"]:
                    if group["verdict"] is None:
                        inspections[p] += 1
                        rate = station_defect_rate(st_cfg[p], crews[p], scenario, done_research, inspections[p] - 1, grades[p])
                        group["verdict"] = rnd["quality"][orders[i]["id"]][pid] < rate
                        if group["verdict"]:
                            cost["rework"] += costs["rework_per_defect"]
                            defects += 1
                            events.append({"day": day, "type": "defect", "ship": orders[i]["id"], "station": pid, "unit": u + 1})
                        else:
                            passes[p] += 1
                    if group["verdict"]:
                        ratio = (scenario["research"]["auto_inspect"]["rework_ratio"]
                                 if "auto_inspect" in done_research else rules["rework_ratio"])
                        cur["remaining"] = cur["amount"] = group["base"] * ratio
                        cur["rework"] = True
                        continue
                # 이 부분은 끝났다. 작업장을 비우고, 다른 부분이 남았으면 짝 대기.
                current[p][u] = None
                group["left"] -= 1
                group["done"].append(u)
                group.setdefault("done_day", {})[u] = day
                if group["left"] > 0:
                    continue
                closed_today[i] = groups.pop(i)
                events.append({"day": day, "type": "complete", "ship": orders[i]["id"], "station": pid, "unit": u + 1})
                stage[i] = p + 1
                if p == n_st - 1:
                    delivered[i] = day
                    events.append({"day": day, "type": "delivery", "ship": orders[i]["id"],
                                   "late_days": max(0, day - orders[i]["due_day"])})
                else:
                    transit[i] = {"from": p, "since": day, "left": float(tr["lot_weight"]), "moving": False}

        for r in schedule:
            if r["end"] == day:
                events.append({"day": day, "type": "research_done", "research": r["id"]})

        # 6. 기록: 배마다 오늘의 상태 하나, 작업장마다 하나.
        for i in range(n_ships):
            if i in ship_state:
                state, p, u = ship_state[i]
                rec = {"state": state, "station": stations[p]["id"], "unit": None if u is None else u + 1}
                group = groups.get(i) or closed_today.get(i)
                if group and len(group["units"]) > 1:
                    # 나눠 하는 중: 부분(작업장)마다 오늘 상태. 먼저 끝난 부분은 짝 대기.
                    gp = group["station"]
                    # 먼저 끝난 부분은 다음 날부터 짝 대기다. 오늘 끝난 부분은 오늘 한 일(작업)로 적는다.
                    finished = group.get("done_day", {})
                    rec["parts"] = [{"unit": v + 1,
                                     "state": PAIR_WAIT if v in finished and finished[v] < day else station_today[gp][v]["state"]}
                                    for v in group["units"]]
                ship_daily[i].append(rec)
            elif delivered[i] is not None:
                ship_daily[i].append({"state": DONE, "station": None})
            else:
                ship_daily[i].append({"state": NOT_STARTED, "station": None})
        for p in range(n_st):
            for u in range(n_units[p]):
                station_daily[p][u].append(station_today[p][u])

        # 7. 비용을 더한다: 재고비, 재공비. (잔업수당, 사고, 고장, 재작업은 위에서 더했다.)
        value = sum(stock[mid] * prices[mid] for mid in stock)
        cost["holding"] += value * costs["holding_rate_per_day"]
        cost["wip"] += sum(costs["wip_per_ship_day"] for i in range(n_ships)
                           if started[i] is not None and delivered[i] is None)
        inventory_daily.append(dict(stock))
        inventory_value_daily.append(value)

    # ----- 기간이 끝난 뒤 한 번에 계산하는 원가 (7장) -----
    skilled_premium = cost["labor"]                     # 숙련공 할증(작업 중에 더했다)
    cost.update(fixed_costs(config, scenario))
    cost["labor"] += skilled_premium
    cost["material"] = sum(bom_of(i, mid) * prices[mid] for i in range(n_ships) for mid in materials)

    late_days = []
    for i, order in enumerate(orders):
        end = delivered[i] if delivered[i] is not None else days
        late = max(0, end - order["due_day"])
        late_days.append(late)
        cost["late_penalty"] += late * order["price"] * costs["late_penalty_rate_per_day"]

    cost = {k: round(v, 2) for k, v in cost.items()}
    total_cost = round(sum(cost.values()), 2)
    revenue = sum(o["price"] for i, o in enumerate(orders) if delivered[i] is not None)

    # ----- 결과 조립 -----
    ships_out = []
    for i, order in enumerate(orders):
        parts = {s: 0 for s in LEAD_TIME_STATES}
        for rec in ship_daily[i]:
            if rec["state"] in parts:
                parts[rec["state"]] += 1
        ships_out.append({
            "id": order["id"],
            "type": order["type"],
            "type_name": types[order["type"]]["name"],
            "order_day": order["order_day"],
            "due_day": order["due_day"],
            "price": order["price"],
            "priority": priority[i],
            "start_day": config["ships"][order["id"]]["start_day"],
            "order_days": order_days[i],
            "arrival_days": {mid: day + materials[mid]["lead_days"] for mid, day in order_days[i].items()},
            "started_day": started[i],
            "delivered_day": delivered[i],
            "late_days": late_days[i],
            "on_time": delivered[i] is not None and late_days[i] == 0,
            "lead_time": sum(parts.values()),
            "lead_time_parts": parts,
            "spans": spans[i],
            "segments": _segments(ship_daily[i]),
            "daily": ship_daily[i],
        })

    top = max_rate(rules)
    stations_out = []
    for p, st in enumerate(stations):
        # 시간가동률의 분모: 일할 수 있었는데 못 한 날까지 (중지, 자재 대기, 인력 대기).
        loaded = busy[p] + accident_stopped[p] + breakdown_stopped[p] + material_wait[p] + labor_wait[p]
        availability = busy[p] / loaded if loaded else None
        performance = work_done[p] / (busy[p] * top) if busy[p] else None
        quality = passes[p] / inspections[p] if inspections[p] else None
        oee = None if None in (availability, performance, quality) else availability * performance * quality
        stations_out.append({
            "id": st["id"],
            "name": st["name"],
            "crew": crews[p],
            "max_rate": station_rate(st_cfg[p], rules, rules["max_workers_per_station"]),
            "defect_rate": station_defect_rate(st_cfg[p], crews[p], scenario, grade=grades[p]),
            "busy_days": busy[p],
            "accident_stop_days": accident_stopped[p],
            "breakdown_stop_days": breakdown_stopped[p],
            "material_wait_days": material_wait[p],
            "labor_wait_days": labor_wait[p],
            "breakdowns": station_breakdowns[p],
            "work_done": work_done[p],
            "inspections": inspections[p],
            "passes": passes[p],
            "oee": {"availability": availability, "performance": performance, "quality": quality, "oee": oee},
            "units": [{"unit": u + 1, "busy_days": unit_busy[p][u], "breakdowns": unit_breakdowns[p][u],
                       "daily": station_daily[p][u]} for u in range(n_units[p])],
            # 1호 작업장의 하루 기록. 화면이 units를 읽게 되면(2.0 화면) 지운다.
            "daily": station_daily[p][0],
        })

    transporters_out = [{
        "id": f"T{k + 1}",
        "moves": tr_moves[k],
        "breakdowns": tr_breakdowns[k],
        "daily": transporter_daily[k],
    } for k in range(n_tr)]

    total_insp, total_pass = sum(inspections), sum(passes)
    on_time = sum(1 for s in ships_out if s["on_time"])
    n_delivered = sum(1 for d in delivered if d is not None)
    n_in_progress = sum(1 for i in range(n_ships) if started[i] is not None and delivered[i] is None)

    return {
        "days": days,
        "qcd": {
            "quality": {"passes": total_pass, "inspections": total_insp,
                        "first_pass_yield": total_pass / total_insp if total_insp else None},
            "cost": {"total": total_cost},
            "delivery": {"on_time": on_time, "ships": n_ships, "on_time_rate": on_time / n_ships,
                         "total_late_days": sum(late_days)},
        },
        "status": {"delivered": n_delivered, "in_progress": n_in_progress,
                   "not_started": n_ships - n_delivered - n_in_progress,
                   "defects": defects, "accidents": accidents,
                   "breakdowns": sum(station_breakdowns) + sum(tr_breakdowns)},
        "costs": cost,
        "total_cost": total_cost,
        "revenue": revenue,
        "profit": round(revenue - total_cost, 2),
        "workforce": {"pool": pool, "man_days": man_days, "idle_man_days": pool * days - man_days,
                      "utilization": man_days / (pool * days), "daily": workforce_daily},
        "ships": ships_out,
        "stations": stations_out,
        "transporters": transporters_out,
        "research": schedule,
        "inventory_daily": inventory_daily,
        "inventory_value_daily": inventory_value_daily,
        "events": events,
        "findings": _findings(ships_out),
        "end_state": {
            "research_done": [r["id"] for r in schedule if r["done"]],
            "stock": dict(stock),
            "in_progress": [{"ship": orders[i]["id"],
                             "station": stations[stage[i]]["id"] if stage[i] < n_st else None}
                            for i in range(n_ships) if started[i] is not None and delivered[i] is None],
        },
    }


def _segments(daily: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """하루 기록을 같은 상태가 이어지는 구간으로 묶는다. 간트 차트용."""
    out: list[dict[str, Any]] = []
    for day, rec in enumerate(daily, start=1):
        if rec["state"] in (NOT_STARTED, DONE):
            continue
        last = out[-1] if out else None
        if last and last["state"] == rec["state"] and last["station"] == rec["station"] and last["end"] == day - 1:
            last["end"] = day
        else:
            out.append({"state": rec["state"], "station": rec["station"], "start": day, "end": day})
    return out


def _findings(ships: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """의문점 카드용 손실 구간. 긴 것부터, 같으면 이른 것부터."""
    out = [{"kind": seg["state"], "ship": ship["id"], "station": seg["station"],
            "start": seg["start"], "end": seg["end"], "days": seg["end"] - seg["start"] + 1}
           for ship in ships for seg in ship["segments"] if seg["state"] in LOSS_STATES]
    return sorted(out, key=lambda f: (-f["days"], f["start"], f["ship"]))


# ---------------------------------------------------------------------------
# 등급 (3.7절)
# ---------------------------------------------------------------------------

def _grade(result: dict[str, Any], config: dict[str, Any], base: dict[str, Any] | None,
           base_cfg: dict[str, Any] | None, scenario: dict[str, Any]) -> dict[str, Any]:
    """점수 = 매출 30 + 이익 40(최대 1.3배) + 납기 20 + 직행률 10. 최고 112점."""
    kpi = scenario["kpi"]
    g = scenario["grade"]
    w = g["weights"]
    days = scenario["days"]

    # KPI 대상: 수주일과 인도 예정일이 모두 분기 안에 있는 배.
    targets = [s for s in result["ships"] if 1 <= s["order_day"] <= days and s["due_day"] <= days]
    revenue = sum(s["price"] for s in targets if s["delivered_day"] is not None)
    on_time_rate = sum(1 for s in targets if s["on_time"]) / len(targets) if targets else 0.0
    fpy = result["qcd"]["quality"]["first_pass_yield"] or 0.0
    profit = result["profit"]

    parts = [
        {"key": "revenue", "name": "인도 매출", "value": revenue, "target": kpi["revenue"], "max": w["revenue"],
         "points": w["revenue"] * min(revenue / kpi["revenue"], 1)},
        {"key": "profit", "name": "이익", "value": profit, "target": kpi["profit"], "max": w["profit"] * g["profit_cap"],
         "points": w["profit"] * min(max(profit / kpi["profit"], 0), g["profit_cap"])},
        {"key": "delivery", "name": "납기 준수율", "value": on_time_rate, "target": kpi["on_time_rate"],
         "max": w["delivery"], "points": w["delivery"] * min(on_time_rate / kpi["on_time_rate"], 1)},
        {"key": "quality", "name": "직행률", "value": fpy, "target": kpi["first_pass_yield"], "max": w["quality"],
         "points": w["quality"] * min(fpy / kpi["first_pass_yield"], 1)},
    ]
    score = round(sum(p["points"] for p in parts), 1)
    for part in parts:
        part["points"] = round(part["points"], 2)

    out: dict[str, Any] = {"score": score, "grade": _band(score, g["bands"]), "parts": parts,
                           "baseline": None, "vs_baseline": None}
    if base is not None and base_cfg is not None:
        base_grade = _grade(base, base_cfg, None, None, scenario)
        preset = next(p for p in load_presets(scenario.get("id", DEFAULT_SCENARIO)) if p["id"] == g["baseline_preset"])
        out["baseline"] = {"preset": preset["id"], "name": preset["name"], "score": base_grade["score"],
                           "grade": base_grade["grade"], "profit": base["profit"], "pool": base_cfg["pool"],
                           "on_time": base["qcd"]["delivery"]["on_time"]}
        out["vs_baseline"] = {"profit": round(profit - base["profit"], 2),
                              "pool": config["pool"] - base_cfg["pool"],
                              "score": round(score - base_grade["score"], 1)}
    return out


def _band(score: float, bands: dict[str, float]) -> str:
    """점수가 넘은 가장 높은 등급. 어느 것도 못 넘으면 F."""
    for name, floor in sorted(bands.items(), key=lambda kv: -kv[1]):
        if score >= floor:
            return name
    return "F"


# ---------------------------------------------------------------------------
# 발주일 역산
# ---------------------------------------------------------------------------

def suggest_order_days(config: dict[str, Any], scenario: dict[str, Any] | None = None,
                       buffer_days: int = 1) -> dict[str, dict[str, int]]:
    """자재가 필요한 날에서 역산한 발주일: 필요일 − 리드타임 − 여유일.

    1.0의 "발주일 역산" 버튼이 쓰던 함수다. 1.1부터 화면은 발주 방식(ordering)을 고르고,
    이 함수는 /api/suggest-orders 하위 호환으로만 남는다.
    """
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    validate_config(config, scenario)
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    return {sid: {mid: _clamp_day(need - lead[mid] - buffer_days, scenario) for mid, need in needs.items()}
            for sid, needs in _need_days(config, scenario).items()}


def resolve_order_days(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, dict[str, int | None]]:
    """발주 방식(ordering)에 따른 배별 발주일. 방식이 없으면 설정의 order_days를 그대로 쓴다.

    bulk: 모든 자재를 1일에. jit: 필요일 − 리드타임 − 여유일. late: 필요일에 (리드타임만큼 자재 대기).
    필요일은 자재가 항상 충분하다고 보고 한 번 돌려서 구한다. 실제 실행에서는 앞 공정이 늦어지면 필요일도 밀린다.
    """
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    ordering = config.get("ordering")
    if ordering is None:
        return {sid: dict(ship.get("order_days") or {}) for sid, ship in config["ships"].items()}
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    if ordering == "bulk":
        return {sid: {mid: 1 for mid in lead} for sid in config["ships"]}
    buffer = scenario["ordering"]["jit"]["buffer_days"]
    offset = {mid: (lead[mid] + buffer if ordering == "jit" else 0) for mid in lead}
    return {sid: {mid: _clamp_day(need - offset[mid], scenario) for mid, need in needs.items()}
            for sid, needs in _need_days(config, scenario).items()}


def _with_order_days(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """발주 방식을 배별 발주일로 풀어 쓴 설정 사본. _run은 order_days만 읽는다."""
    if config.get("ordering") is None:
        return config
    validate_config(config, scenario)
    resolved = copy.deepcopy(config)
    for sid, days in resolve_order_days(config, scenario).items():
        resolved["ships"][sid]["order_days"] = days
    return resolved


def _need_days(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, dict[str, int]]:
    """자재가 항상 충분할 때 각 배가 자재를 처음 쓰는 날. 쓰지 못하면 마지막 날."""
    probe_scenario = copy.deepcopy(scenario)
    probe_scenario["initial_stock"] = {m["id"]: 10 ** 6 for m in scenario["materials"]}
    probe_config = copy.deepcopy(config)
    probe_config.pop("ordering", None)
    for ship in probe_config["ships"].values():
        ship["order_days"] = {}
    result = _run(probe_config, probe_scenario)

    station_material = {s["id"]: s["material"] for s in scenario["stations"] if s["material"]}
    needs: dict[str, dict[str, int]] = {}
    for ship in result["ships"]:
        needs[ship["id"]] = {}
        for pid, mid in station_material.items():
            span = ship["spans"].get(pid)
            needs[ship["id"]][mid] = span["start"] if span else scenario["days"]
    return needs


def _clamp_day(day: int, scenario: dict[str, Any]) -> int:
    return min(scenario["days"], max(1, day))
