"""종이배 조선소 시뮬레이션 엔진.

규칙 문서의 9장 "하루 진행 순서"를 그대로 옮긴 순수 함수다.
설정(dict)을 넣으면 60일치 기록과 레포트 값(dict)이 나온다.
표준 라이브러리만 쓰고, 화면이나 서버를 전혀 모른다.

    from shipyard import simulate, load_presets
    result = simulate(load_presets()[1]["config"])
    print(result["qcd"], result["profit"])
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent / "data"

# 배의 하루 상태. 리드타임 분해에 쓰는 것은 앞의 다섯 개다.
WORK = "work"                      # 작업
REWORK = "rework"                  # 재작업
MATERIAL_WAIT = "material_wait"    # 자재 대기
STATION_WAIT = "station_wait"      # 작업장 대기
ACCIDENT_STOP = "accident_stop"    # 사고 중지
NOT_STARTED = "not_started"        # 착수 전
DONE = "done"                      # 인도 후
BREAKDOWN_STATES = [WORK, REWORK, MATERIAL_WAIT, STATION_WAIT, ACCIDENT_STOP]

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
    """수주, BOM, 단가, 난수표 등 규칙 문서 2~7장의 숫자."""
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
        workers = st.get("workers")
        if not _is_int(workers) or not 1 <= workers <= rules["max_workers_per_station"]:
            errors.append(f"{pid}: 작업자는 1~{rules['max_workers_per_station']}명이어야 합니다")
        if st.get("method") not in rules["methods"]:
            errors.append(f"{pid}: 공법은 {', '.join(rules['methods'])} 중 하나여야 합니다")
        for key in ("overtime", "maintenance"):
            if not isinstance(st.get(key), bool):
                errors.append(f"{pid}: {key}는 true 또는 false여야 합니다")

    skilled = config.get("skilled_station")
    if skilled is not None and skilled not in station_ids:
        errors.append("숙련공은 작업장 하나에 두거나 미배치(null)여야 합니다")

    if errors:
        raise ConfigError(errors)


# ---------------------------------------------------------------------------
# 작업장 계산식 (3장, 5장)
# ---------------------------------------------------------------------------

def station_rate(station_cfg: dict[str, Any], rules: dict[str, Any]) -> float:
    """하루 처리량 = min(작업자 수, 설비 수용 인원) × 공법 속도 × 잔업 계수."""
    workers = min(station_cfg["workers"], rules["max_workers_per_station"])
    speed = rules["methods"][station_cfg["method"]]["speed"]
    overtime = rules["overtime"]["speed"] if station_cfg["overtime"] else 1.0
    return workers * speed * overtime


def station_defect_rate(station_cfg: dict[str, Any], is_skilled: bool, rules: dict[str, Any]) -> float:
    """불량률 = 공법 기본값 + 잔업 + 미정비 − 숙련공."""
    rate = rules["methods"][station_cfg["method"]]["defect_rate"]
    if station_cfg["overtime"]:
        rate += rules["overtime"]["defect_add"]
    if not station_cfg["maintenance"]:
        rate += rules["no_maintenance_defect_add"]
    if is_skilled:
        rate -= rules["skilled_defect_reduction"]
    return round(max(0.0, rate), 6)


def max_rate(rules: dict[str, Any]) -> float:
    """작업장이 낼 수 있는 최대 처리량. OEE 성능가동률의 기준이다."""
    top_speed = max(m["speed"] for m in rules["methods"].values())
    return rules["max_workers_per_station"] * top_speed * rules["overtime"]["speed"]


def preview(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, Any]:
    """실행하지 않고 설정만으로 알 수 있는 값: 작업장별 처리량, 불량률, 고정비."""
    scenario = scenario or load_scenario()
    validate_config(config, scenario)
    rules = scenario["rules"]
    costs = rules["costs"]
    stations = {}
    for st in scenario["stations"]:
        cfg = config["stations"][st["id"]]
        stations[st["id"]] = {
            "rate": station_rate(cfg, rules),
            "defect_rate": station_defect_rate(cfg, config.get("skilled_station") == st["id"], rules),
        }
    workers = sum(config["stations"][s["id"]]["workers"] for s in scenario["stations"])
    skilled = 1 if config.get("skilled_station") else 0
    labor = (workers * costs["wage_per_day"] + skilled * costs["skilled_bonus_per_day"]) * scenario["days"]
    maintenance = sum(1 for s in scenario["stations"] if config["stations"][s["id"]]["maintenance"]) * costs["maintenance_per_station"]
    return {"stations": stations, "fixed_costs": {"labor": labor, "maintenance": maintenance}}


# ---------------------------------------------------------------------------
# 시뮬레이션 (9장)
# ---------------------------------------------------------------------------

def simulate(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, Any]:
    """설정으로 시나리오 기간 전체를 돌리고 기록과 레포트 값을 돌려준다.

    같은 설정이면 항상 같은 결과가 나온다. 난수는 시나리오의 표에서 읽는다.
    """
    scenario = scenario or load_scenario()
    validate_config(config, scenario)

    days: int = scenario["days"]
    rules = scenario["rules"]
    costs = rules["costs"]
    ot = rules["overtime"]
    orders = scenario["orders"]
    stations = scenario["stations"]
    materials = {m["id"]: m for m in scenario["materials"]}
    types = scenario["ship_types"]
    n_ships, n_st = len(orders), len(stations)
    ship_index = {o["id"]: i for i, o in enumerate(orders)}

    st_cfg = [config["stations"][s["id"]] for s in stations]
    skilled = config.get("skilled_station")
    rate = [station_rate(c, rules) for c in st_cfg]
    defect = [station_defect_rate(c, skilled == s["id"], rules) for c, s in zip(st_cfg, stations)]

    def work_of(ship: int, p: int) -> float:
        return types[orders[ship]["type"]]["work"][stations[p]["id"]]

    def bom_of(ship: int, material: str) -> int:
        return types[orders[ship]["type"]]["bom"].get(material, 0)

    # 우선순위 숫자가 작은 배부터 본다.
    by_priority = sorted(range(n_ships), key=lambda i: config["ships"][orders[i]["id"]]["priority"])

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
    started: list[int | None] = [None] * n_ships           # 재단에 들어간 날
    delivered: list[int | None] = [None] * n_ships
    current: list[dict[str, Any] | None] = [None] * n_st   # 작업장에 들어가 있는 배
    stop_until = [0] * n_st
    overtime_days = [0] * n_st

    ship_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_ships)]
    station_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_st)]
    spans: list[dict[str, dict[str, int]]] = [{} for _ in range(n_ships)]
    inventory_daily: list[dict[str, int]] = []
    events: list[dict[str, Any]] = []

    busy = [0] * n_st
    stopped = [0] * n_st
    material_wait = [0] * n_st
    work_done = [0.0] * n_st
    inspections = [0] * n_st
    passes = [0] * n_st
    accidents = 0
    defects = 0

    cost = {
        "labor": 0.0, "overtime": 0.0, "maintenance": 0.0, "material": 0.0, "holding": 0.0,
        "wip": 0.0, "rework": 0.0, "accident": 0.0, "late_penalty": 0.0,
    }

    for day in range(1, days + 1):
        # 1. 입고
        for mid, qty, for_ship in arrivals.get(day, []):
            stock[mid] += qty
            events.append({"day": day, "type": "arrival", "material": mid, "quantity": qty, "ship": for_ship})

        ship_state: dict[int, tuple[str, int]] = {}

        # 2. 작업장을 공정 순서대로 처리
        for p in range(n_st):
            pid = stations[p]["id"]
            cur = current[p]
            waiting = [i for i in by_priority
                       if delivered[i] is None and stage[i] == p and ready[i] <= day
                       and not (cur and cur["ship"] == i)]

            # 2-1. 사고 중지 중이면 건너뛴다.
            if day <= stop_until[p]:
                stopped[p] += 1
                for i in waiting + ([cur["ship"]] if cur else []):
                    ship_state[i] = (ACCIDENT_STOP, p)
                station_daily[p].append({"state": ACCIDENT_STOP, "ship": orders[cur["ship"]]["id"] if cur else None})
                continue

            # 2-2. 비어 있으면 우선순위 순으로 들어올 배를 찾는다.
            if cur is None:
                mid = stations[p]["material"]
                for i in waiting:
                    need = bom_of(i, mid) if mid else 0
                    if mid and stock[mid] < need:
                        ship_state[i] = (MATERIAL_WAIT, p)
                        continue
                    if mid:
                        stock[mid] -= need
                    cur = current[p] = {"ship": i, "remaining": work_of(i, p), "rework": False}
                    spans[i][pid] = {"start": day, "end": day}
                    if p == 0:
                        started[i] = day
                    events.append({"day": day, "type": "enter", "ship": orders[i]["id"], "station": pid})
                    break
            for i in waiting:
                if i not in ship_state and not (cur and cur["ship"] == i):
                    ship_state[i] = (STATION_WAIT, p)

            if cur is None:
                blocked = any(ship_state.get(i, ("", -1))[0] == MATERIAL_WAIT for i in waiting)
                if blocked:
                    material_wait[p] += 1
                station_daily[p].append({"state": MATERIAL_WAIT if blocked else "idle", "ship": None})
                continue

            # 2-3. 남은 작업량에서 처리량을 뺀다. 오늘 들어온 배도 오늘부터 작업한다.
            i = cur["ship"]
            cur["remaining"] -= rate[p]
            busy[p] += 1
            state = REWORK if cur["rework"] else WORK
            ship_state[i] = (state, p)
            station_daily[p].append({"state": state, "ship": orders[i]["id"]})
            spans[i][pid]["end"] = day

            # 2-4. 잔업일을 세고, 정해진 간격마다 사고 판정을 한다.
            if st_cfg[p]["overtime"]:
                overtime_days[p] += 1
                cost["overtime"] += st_cfg[p]["workers"] * costs["wage_per_day"] * ot["pay_rate"]
                if overtime_days[p] % ot["accident_every_days"] == 0:
                    table = scenario["random"]["accident"][pid]
                    k = overtime_days[p] // ot["accident_every_days"]
                    if table[(k - 1) % len(table)] < ot["accident_threshold"]:
                        stop_until[p] = day + ot["accident_stop_days"]
                        cost["accident"] += costs["accident"]
                        accidents += 1
                        events.append({"day": day, "type": "accident", "station": pid, "ship": orders[i]["id"]})

            # 2-5. 다 끝났으면 검사하고, 불량이면 재작업량을 넣는다.
            if cur["remaining"] <= EPS:
                base = work_of(i, p)
                work_done[p] += base * (rules["rework_ratio"] if cur["rework"] else 1.0)
                if not cur["rework"]:
                    inspections[p] += 1
                    u = scenario["random"]["quality"][orders[i]["id"]][pid]
                    if u < defect[p]:
                        cur["remaining"] = base * rules["rework_ratio"]
                        cur["rework"] = True
                        cost["rework"] += costs["rework_per_defect"]
                        defects += 1
                        events.append({"day": day, "type": "defect", "ship": orders[i]["id"], "station": pid})
                        continue
                    passes[p] += 1
                events.append({"day": day, "type": "complete", "ship": orders[i]["id"], "station": pid})
                stage[i], ready[i], current[p] = p + 1, day + 1, None
                if p == n_st - 1:
                    delivered[i] = day
                    events.append({"day": day, "type": "delivery", "ship": orders[i]["id"],
                                   "late_days": max(0, day - orders[i]["due_day"])})

        # 3. 배마다 오늘의 상태 하나를 기록한다.
        for i in range(n_ships):
            if i in ship_state:
                state, p = ship_state[i]
                ship_daily[i].append({"state": state, "station": stations[p]["id"]})
            elif delivered[i] is not None:
                ship_daily[i].append({"state": DONE, "station": None})
            else:
                ship_daily[i].append({"state": NOT_STARTED, "station": None})

        # 4. 비용을 더한다: 재고비, 재공비. (잔업수당은 2-4에서 더했다.)
        cost["holding"] += sum(stock[mid] * materials[mid]["price"] for mid in stock) * costs["holding_rate_per_day"]
        cost["wip"] += sum(costs["wip_per_ship_day"] for i in range(n_ships)
                           if started[i] is not None and delivered[i] is None)
        inventory_daily.append(dict(stock))

    # ----- 기간이 끝난 뒤 한 번에 계산하는 원가 (7장) -----
    total_workers = sum(c["workers"] for c in st_cfg)
    cost["labor"] = (total_workers * costs["wage_per_day"]
                     + (costs["skilled_bonus_per_day"] if skilled else 0)) * days
    cost["maintenance"] = sum(1 for c in st_cfg if c["maintenance"]) * costs["maintenance_per_station"]
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
        breakdown = {s: 0 for s in BREAKDOWN_STATES}
        for rec in ship_daily[i]:
            if rec["state"] in breakdown:
                breakdown[rec["state"]] += 1
        ships_out.append({
            "id": order["id"],
            "type": order["type"],
            "type_name": types[order["type"]]["name"],
            "due_day": order["due_day"],
            "price": order["price"],
            "start_day": config["ships"][order["id"]]["start_day"],
            "started_day": started[i],
            "delivered_day": delivered[i],
            "late_days": late_days[i],
            "on_time": delivered[i] is not None and late_days[i] == 0,
            "lead_time": sum(breakdown.values()),
            "breakdown": breakdown,
            "spans": spans[i],
            "segments": _segments(ship_daily[i]),
            "daily": ship_daily[i],
        })

    top = max_rate(rules)
    stations_out = []
    for p, st in enumerate(stations):
        loaded = busy[p] + stopped[p] + material_wait[p]
        availability = busy[p] / loaded if loaded else None
        performance = work_done[p] / (busy[p] * top) if busy[p] else None
        quality = passes[p] / inspections[p] if inspections[p] else None
        oee = None if None in (availability, performance, quality) else availability * performance * quality
        stations_out.append({
            "id": st["id"],
            "name": st["name"],
            "rate": rate[p],
            "defect_rate": defect[p],
            "busy_days": busy[p],
            "accident_stop_days": stopped[p],
            "material_wait_days": material_wait[p],
            "work_done": work_done[p],
            "inspections": inspections[p],
            "passes": passes[p],
            "oee": {"availability": availability, "performance": performance, "quality": quality, "oee": oee},
            "daily": station_daily[p],
        })

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
                   "defects": defects, "accidents": accidents},
        "costs": cost,
        "total_cost": total_cost,
        "revenue": revenue,
        "profit": round(revenue - total_cost, 2),
        "ships": ships_out,
        "stations": stations_out,
        "inventory_daily": inventory_daily,
        "events": events,
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
    result = simulate(probe_config, probe_scenario)

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
