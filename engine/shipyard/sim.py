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

COST_KEYS = ["labor", "overtime", "maintenance", "material", "holding", "wip", "rework",
             "accident", "breakdown", "transporter", "research", "late_penalty"]

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

def load_scenario() -> dict[str, Any]:
    """수주, BOM, 단가, 난수표 등 규칙의 모든 숫자."""
    return json.loads((DATA_DIR / "scenario.json").read_text(encoding="utf-8"))


def load_presets() -> list[dict[str, Any]]:
    """규칙 문서 10장의 프리셋 3개 (무관리, 관리, 전부 최대 투입)."""
    return json.loads((DATA_DIR / "presets.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 설정 검사
# ---------------------------------------------------------------------------

def validate_config(config: dict[str, Any], scenario: dict[str, Any]) -> None:
    """설정이 4장의 선택지 안에 있는지 확인한다. 틀리면 ConfigError."""
    errors: list[str] = []
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
            errors.append(f"{sid}: 착수일은 1~{days} 사이의 정수여야 합니다")
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

    skilled = config.get("skilled_station")
    if skilled is not None and skilled not in station_ids:
        errors.append("시니어는 공정 하나에 두거나 미배치(null)여야 합니다")

    if errors:
        raise ConfigError(errors)


# ---------------------------------------------------------------------------
# 계산식 (3장, 5장)
# ---------------------------------------------------------------------------

def station_rate(station_cfg: dict[str, Any], rules: dict[str, Any], assigned: int, worker_factor: float = 1) -> float:
    """하루 처리량 = min(배정 인원 × 자동화 배수, 설비 수용 인원) × 공법 속도 × 잔업 계수."""
    workers = min(assigned * worker_factor, rules["max_workers_per_station"])
    speed = rules["methods"][station_cfg["method"]]["speed"]
    overtime = rules["overtime"]["speed"] if station_cfg["overtime"] else 1.0
    return workers * speed * overtime


def station_defect_rate(station_cfg: dict[str, Any], is_skilled: bool, scenario: dict[str, Any],
                        research: frozenset[str] = frozenset()) -> float:
    """불량률 = 공법 기본값 + 잔업 + 미정비 − 시니어 − 자동 검사. research는 효과가 난 연구."""
    rules = scenario["rules"]
    rate = rules["methods"][station_cfg["method"]]["defect_rate"]
    if station_cfg["overtime"]:
        rate += rules["overtime"]["defect_add"]
    if not station_cfg["maintenance"] and "predictive" not in research:
        rate += rules["no_maintenance_defect_add"]
    if is_skilled:
        rate -= rules["skilled_defect_reduction"]
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


def fixed_costs(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, float]:
    """실행 전에 정해지는 비용: 인건비, 정비비, 트랜스포터, 연구비."""
    costs = scenario["rules"]["costs"]
    tr = scenario["transporter"]
    days = scenario["days"]
    n_tr = config["transporters"]["count"]
    return {
        "labor": (config["pool"] * costs["wage_per_day"]
                  + (costs["skilled_bonus_per_day"] if config.get("skilled_station") else 0)) * days,
        "maintenance": sum(1 for s in scenario["stations"] if config["stations"][s["id"]]["maintenance"])
        * costs["maintenance_per_station"],
        "transporter": n_tr * tr["cost_per_day"] * days
        + (n_tr * tr["maintenance_cost"] if config["transporters"]["maintenance"] else 0),
        "research": sum(scenario["research"][r]["cost"] for r in config.get("research", [])),
    }


def preview(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, Any]:
    """실행하지 않고 설정만으로 알 수 있는 값: 공정별 최대 처리량과 불량률, 고정비, 연구 일정."""
    scenario = scenario or load_scenario()
    validate_config(config, scenario)
    rules = scenario["rules"]
    every = frozenset(config.get("research", []))
    stations = {}
    for st in scenario["stations"]:
        cfg = config["stations"][st["id"]]
        skilled = config.get("skilled_station") == st["id"]
        stations[st["id"]] = {
            "rate": station_rate(cfg, rules, rules["max_workers_per_station"]),
            "defect_rate": station_defect_rate(cfg, skilled, scenario),
            "defect_rate_final": station_defect_rate(cfg, skilled, scenario, every),
        }
    return {"stations": stations, "fixed_costs": fixed_costs(config, scenario),
            "research": research_schedule(config.get("research", []), scenario)}


# ---------------------------------------------------------------------------
# 시뮬레이션 (9장)
# ---------------------------------------------------------------------------

def simulate(config: dict[str, Any], scenario: dict[str, Any] | None = None, baseline: bool = True) -> dict[str, Any]:
    """설정으로 시나리오 기간 전체를 돌리고 기록, 레포트 값, 등급을 돌려준다.

    같은 설정이면 항상 같은 결과가 나온다. 난수는 시나리오의 표에서 읽는다.
    baseline이 참이면 기준선 프리셋(전부 최대 투입)도 같은 시나리오로 돌려 등급에 비교를 붙인다.
    """
    scenario = scenario or load_scenario()
    result = _run(config, scenario)
    base_cfg = _baseline_config(scenario) if baseline else None
    base = _run(base_cfg, scenario) if base_cfg is not None else None
    result["grade"] = _grade(result, config, base, base_cfg, scenario)
    return result


def _baseline_config(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """기준선 프리셋 설정. 시나리오의 배가 프리셋과 다르면(손 계산용 시나리오 등) 없다."""
    pid = scenario["grade"]["baseline_preset"]
    preset = next(p for p in load_presets() if p["id"] == pid)
    if set(preset["config"]["ships"]) != {o["id"] for o in scenario["orders"]}:
        return None
    return preset["config"]


def _run(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
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

    st_cfg = [config["stations"][s["id"]] for s in stations]
    skilled = config.get("skilled_station")
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
    arrivals: dict[int, list[tuple[str, int, str]]] = {}
    for i, order in enumerate(orders):
        for mid, day in (config["ships"][order["id"]].get("order_days") or {}).items():
            qty = bom_of(i, mid)
            if day is None or qty == 0:
                continue
            arrivals.setdefault(day + materials[mid]["lead_days"], []).append((mid, qty, order["id"]))

    stock = {mid: scenario.get("initial_stock", {}).get(mid, 0) for mid in materials}
    stage = [0] * n_ships                                  # 다음에 들어갈 공정
    ready = [config["ships"][o["id"]]["start_day"] for o in orders]   # 그 공정에 들어갈 수 있는 첫날
    started: list[int | None] = [None] * n_ships           # 소조립에 들어간 날
    delivered: list[int | None] = [None] * n_ships
    current: list[dict[str, Any] | None] = [None] * n_st   # 작업장에 들어가 있는 로트
    stop_until = [0] * n_st
    stop_cause = [ACCIDENT_STOP] * n_st
    overtime_days = [0] * n_st
    transit: dict[int, dict[str, Any]] = {}                # 공정 사이를 옮기는 로트
    tr_moves = [0] * n_tr
    tr_stop_until = [0] * n_tr

    ship_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_ships)]
    station_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_st)]
    transporter_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_tr)]
    workforce_daily: list[dict[str, int]] = []
    spans: list[dict[str, dict[str, int]]] = [{} for _ in range(n_ships)]
    inventory_daily: list[dict[str, int]] = []
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
        ship_state: dict[int, tuple[str, int]] = {}
        station_today: list[dict[str, Any]] = [{"state": "idle", "ship": None, "workers": 0} for _ in range(n_st)]

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
                ship_state[i] = (TRANSPORT if took else TRANSPORT_WAIT, lot["from"])

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

        # 3. 투입: 작업장을 공정 순서대로 보고, 비어 있으면 우선순위 순으로 들어올 로트를 찾는다.
        for p in range(n_st):
            pid = stations[p]["id"]
            cur = current[p]
            waiting = [i for i in by_priority
                       if delivered[i] is None and i not in transit and stage[i] == p and ready[i] <= day
                       and not (cur and cur["ship"] == i)]

            # 3-1. 사고나 고장으로 중지 중이면 건너뛴다.
            if day <= stop_until[p]:
                cause = stop_cause[p]
                if cause == ACCIDENT_STOP:
                    accident_stopped[p] += 1
                else:
                    breakdown_stopped[p] += 1
                for i in waiting + ([cur["ship"]] if cur else []):
                    ship_state[i] = (cause, p)
                station_today[p] = {"state": cause, "ship": orders[cur["ship"]]["id"] if cur else None, "workers": 0}
                continue

            # 3-2. 비어 있으면 자재를 꺼내(출고) 로트를 들인다.
            if cur is None:
                mid = stations[p]["material"]
                for i in waiting:
                    need = bom_of(i, mid) if mid else 0
                    if mid and stock[mid] < need:
                        ship_state[i] = (MATERIAL_WAIT, p)
                        continue
                    if mid:
                        stock[mid] -= need
                        events.append({"day": day, "type": "issue", "material": mid, "quantity": need,
                                       "ship": orders[i]["id"], "station": pid})
                    work = work_of(i, p)
                    cur = current[p] = {"ship": i, "remaining": work, "amount": work, "rework": False}
                    spans[i][pid] = {"start": day, "end": day}
                    if p == 0:
                        started[i] = day
                    events.append({"day": day, "type": "enter", "ship": orders[i]["id"], "station": pid})
                    break
            for i in waiting:
                if i not in ship_state and not (cur and cur["ship"] == i):
                    ship_state[i] = (STATION_WAIT, p)

            if cur is None and any(ship_state.get(i, ("", -1))[0] == MATERIAL_WAIT for i in waiting):
                material_wait[p] += 1
                station_today[p] = {"state": MATERIAL_WAIT, "ship": None, "workers": 0}

        # 4. 인원 배정: 로트가 있고 중지가 아닌 작업장에, 그 로트의 배 우선순위 순으로 사람을 보낸다.
        automated = "automation" in done_research
        need = automation["workers_needed"] if automated else rules["max_workers_per_station"]
        factor = automation["worker_factor"] if automated else 1
        idle = pool
        assigned = [0] * n_st
        for p in sorted((p for p in range(n_st) if current[p] and day > stop_until[p]),
                        key=lambda p: priority[current[p]["ship"]]):
            assigned[p] = min(need, idle)
            idle -= assigned[p]
        man_days += pool - idle
        workforce_daily.append({"assigned": pool - idle, "idle": idle})

        # 5. 작업: 남은 작업량에서 처리량을 뺀다. 오늘 들어온 로트도 오늘부터 작업한다.
        for p in range(n_st):
            cur = current[p]
            if cur is None or day <= stop_until[p]:
                continue
            pid = stations[p]["id"]
            i = cur["ship"]
            if assigned[p] == 0:
                labor_wait[p] += 1
                ship_state[i] = (LABOR_WAIT, p)
                station_today[p] = {"state": LABOR_WAIT, "ship": orders[i]["id"], "workers": 0}
                continue

            cur["remaining"] -= station_rate(st_cfg[p], rules, assigned[p], factor)
            busy[p] += 1
            state = REWORK if cur["rework"] else WORK
            ship_state[i] = (state, p)
            station_today[p] = {"state": state, "ship": orders[i]["id"], "workers": assigned[p]}
            spans[i][pid]["end"] = day

            # 5-1. 잔업일을 세고, 정해진 간격마다 사고 판정을 한다.
            if st_cfg[p]["overtime"]:
                overtime_days[p] += 1
                cost["overtime"] += assigned[p] * costs["wage_per_day"] * ot["pay_rate"]
                if overtime_days[p] % ot["accident_every_days"] == 0:
                    table = rnd["accident"][pid]
                    n = overtime_days[p] // ot["accident_every_days"]
                    if table[(n - 1) % len(table)] < ot["accident_threshold"]:
                        stop_until[p] = day + ot["accident_stop_days"]
                        stop_cause[p] = ACCIDENT_STOP
                        cost["accident"] += costs["accident"]
                        accidents += 1
                        events.append({"day": day, "type": "accident", "station": pid, "ship": orders[i]["id"]})

            # 5-2. 일한 날을 세고, 정해진 간격마다 고장 판정을 한다. 오늘 사고로 멈췄으면 판정하지 않는다.
            if busy[p] % bd["every_busy_days"] == 0 and day > stop_until[p]:
                threshold = 0 if "predictive" in done_research else (
                    bd["threshold_maintained"] if st_cfg[p]["maintenance"] else bd["threshold"])
                table = rnd["breakdown"][pid]
                n = busy[p] // bd["every_busy_days"]
                if table[(n - 1) % len(table)] < threshold:
                    stop_until[p] = day + bd["stop_days"]
                    stop_cause[p] = BREAKDOWN_STOP
                    cost["breakdown"] += bd["cost"]
                    station_breakdowns[p] += 1
                    events.append({"day": day, "type": "breakdown", "station": pid, "ship": orders[i]["id"]})

            # 5-3. 다 끝났으면 검사하고, 불량이면 재작업량을 넣는다. 합격하면 다음 날부터 운반을 기다린다.
            if cur["remaining"] <= EPS:
                work_done[p] += cur["amount"]
                if not cur["rework"]:
                    inspections[p] += 1
                    rate = station_defect_rate(st_cfg[p], skilled == pid, scenario, done_research)
                    if rnd["quality"][orders[i]["id"]][pid] < rate:
                        ratio = (scenario["research"]["auto_inspect"]["rework_ratio"]
                                 if "auto_inspect" in done_research else rules["rework_ratio"])
                        cur["remaining"] = cur["amount"] = work_of(i, p) * ratio
                        cur["rework"] = True
                        cost["rework"] += costs["rework_per_defect"]
                        defects += 1
                        events.append({"day": day, "type": "defect", "ship": orders[i]["id"], "station": pid})
                        continue
                    passes[p] += 1
                events.append({"day": day, "type": "complete", "ship": orders[i]["id"], "station": pid})
                stage[i], current[p] = p + 1, None
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
                state, p = ship_state[i]
                ship_daily[i].append({"state": state, "station": stations[p]["id"]})
            elif delivered[i] is not None:
                ship_daily[i].append({"state": DONE, "station": None})
            else:
                ship_daily[i].append({"state": NOT_STARTED, "station": None})
        for p in range(n_st):
            station_daily[p].append(station_today[p])

        # 7. 비용을 더한다: 재고비, 재공비. (잔업수당, 사고, 고장, 재작업은 위에서 더했다.)
        cost["holding"] += sum(stock[mid] * materials[mid]["price"] for mid in stock) * costs["holding_rate_per_day"]
        cost["wip"] += sum(costs["wip_per_ship_day"] for i in range(n_ships)
                           if started[i] is not None and delivered[i] is None)
        inventory_daily.append(dict(stock))

    # ----- 기간이 끝난 뒤 한 번에 계산하는 원가 (7장) -----
    cost.update(fixed_costs(config, scenario))
    cost["material"] = sum(bom_of(i, mid) * materials[mid]["price"] for i in range(n_ships) for mid in materials)

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
            "max_rate": station_rate(st_cfg[p], rules, rules["max_workers_per_station"]),
            "defect_rate": station_defect_rate(st_cfg[p], skilled == st["id"], scenario),
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
            "daily": station_daily[p],
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
        preset = next(p for p in load_presets() if p["id"] == g["baseline_preset"])
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

    자재가 항상 충분하다고 보고 한 번 돌려서 각 배가 자재를 쓰는 날을 구한다.
    """
    scenario = scenario or load_scenario()
    validate_config(config, scenario)
    probe_scenario = copy.deepcopy(scenario)
    probe_scenario["initial_stock"] = {m["id"]: 10 ** 6 for m in scenario["materials"]}
    probe_config = copy.deepcopy(config)
    for ship in probe_config["ships"].values():
        ship["order_days"] = {}
    result = _run(probe_config, probe_scenario)

    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    station_material = {s["id"]: s["material"] for s in scenario["stations"] if s["material"]}
    suggestion: dict[str, dict[str, int]] = {}
    for ship in result["ships"]:
        days_for_ship = {}
        for pid, mid in station_material.items():
            span = ship["spans"].get(pid)
            need_day = span["start"] if span else scenario["days"]
            days_for_ship[mid] = min(scenario["days"], max(1, need_day - lead[mid] - buffer_days))
        suggestion[ship["id"]] = days_for_ship
    return suggestion
