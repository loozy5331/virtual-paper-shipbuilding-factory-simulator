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
import hashlib
import json
import math
import threading
from collections import OrderedDict
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
# 트랜스포터 이름(4.3, D46): 블록 한 대. 4.2까지는 T1 자재·T2 블록 두 대였다(자재는 이제 공용 지게차 F1~F3).
TRANSPORTER_IDS = ["TR", "TR2"]   # 블록 트랜스포터(4.8: 1~2대)
# 블록 이름의 공정 약자(4.25): S1-SA3 = S1 소조립 3번 블록. 화면은 소·중·PE로 쓴다
BLOCK_CODES = {"sub_assembly": "SA", "block_assembly": "BA", "grand_assembly": "GA"}
# 블록 공정의 우선순위 규칙(4.25): 선박 순서·납기 빠른 순·여유 작은 순·작업 짧은 순. 추천도 이 순서로 비교한다
DISPATCH_RULES = ["ship", "edd", "slack", "spt"]
# 블록 공정에 있는 배의 하루 상태(4.25): 블록들의 오늘 상태 가운데 이 순서로 앞선 것 하나(같으면 뒤 공정)
BLOCK_SHIP_RANK = [WORK, REWORK, LABOR_WAIT, ACCIDENT_STOP, BREAKDOWN_STOP, MATERIAL_WAIT, STATION_WAIT, TRANSPORT, TRANSPORT_WAIT]

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
    """고를 수 있는 시나리오. 난이도(level) 순: 옛 분기가 쉽고 나중 분기가 어렵다.
    실습(track "drill", 4.25 블록 조립)은 사다리(D67) 밖이라 맨 뒤에 둔다."""
    meta = {p.stem: _read(p) for p in (DATA_DIR / "scenarios").glob("*.json")}
    return sorted(meta, key=lambda sid: (meta[sid].get("track") == "drill", meta[sid].get("level", 0), sid))


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
                    # 실습(4.25)은 사다리 밖: 첫 화면은 맨 끝에 "실습" 카드로 그린다
                    **({"track": sc["track"]} if sc.get("track") else {}),
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
    # 간이공정(4.4, D47): 시나리오가 쓰지 않는 공정(skip)과 공정별 자재(station_material)를 정한다.
    # 공정 목록과 번호는 그대로 두고(화면 번호가 같다), 쓰지 않는 공정은 처음부터 마친 것으로 보고 건너뛴다.
    skip = set(sc.get("skip", []))
    material = sc.get("station_material", {})
    stations = [{**st, "material": None if st["id"] in skip else material.get(st["id"], st.get("material")),
                 **({"skipped": True} if st["id"] in skip else {})} for st in rules["stations"]]
    return {**sc, **rules, "stations": stations, "skip": [st["id"] for st in stations if st["id"] in skip], "random": random}


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


def complete_config(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """4.0 설정 모양으로 채운다(D41·D42). 옛 설정도 그대로 돌게 한다.

    - 시나리오의 공정 중 설정에 없는 공정(1.x~3.x 설정의 도장·선행의장·안벽의장·시운전)은 기본값(표준, 잔업 없음, 정비).
    - 직종별 대기소 인원 pools. 없으면 옛 pool을 조립 인원으로 읽고 나머지 직종은 default_pools.
      4.21까지 설정에 없는 시운전 인원도 default_pools(간이공정은 options.trial_pools)로 채운다(4.22).
    - pool은 대기소 전체 인원(pools 합)으로 맞춘다(결과·기준선 비교가 읽는다).
    """
    if not isinstance(config, dict) or not isinstance(config.get("stations"), dict):
        return config
    out = dict(config)
    stations = dict(config["stations"])
    for st in scenario["stations"]:
        if st["id"] not in stations:
            stations[st["id"]] = {"method": "standard", "overtime": False, "maintenance": True}
    out["stations"] = stations
    trades = active_trades(scenario)
    pools = config.get("pools")
    defaults = {k: v for k, v in scenario["default_pools"].items() if not k.startswith("_")}
    # 시운전 인원(4.22, D69): 4.21까지 설정에는 없다. 인원을 고정한 분기(간이공정)는 그 값으로 채운다
    fixed_trial = (scenario.get("options") or {}).get("trial_pools")
    if fixed_trial:
        defaults["trial"] = fixed_trial[0]
    if not isinstance(pools, dict):
        pools = {t: (config.get("pool") if t == "assembly" else defaults.get(t, 1)) for t in trades}
    else:
        # 4.0 개발 중 설정처럼 직종이 덜 적힌 pools(가공 직종 전, 4.21까지의 시운전)는 빠진 직종을 기본 인원으로 채운다
        pools = {**{t: defaults.get(t, 1) for t in trades if t not in pools}, **pools}
    pools = {t: v for t, v in pools.items() if t in trades}
    out["pools"] = pools
    if all(_is_int(v) for v in pools.values()):
        out["pool"] = sum(pools.values())
    # 블록 트랜스포터 대수(4.8): 없으면 기본 대수(1대, 4.7 이전 설정과 같은 결과)
    trc = config.get("transporters")
    trc = dict(trc) if isinstance(trc, dict) else {}
    trc.setdefault("count", scenario.get("transporter", {}).get("default_count", 1))
    out["transporters"] = trc
    # 공용 지게차(4.3): 없으면 기본 대수, 정비는 트랜스포터 정비를 따른다(4.2 이전 설정)
    if "forklift" in scenario:
        fk = config.get("forklifts")
        fk = dict(fk) if isinstance(fk, dict) else {}
        fk.setdefault("count", scenario["forklift"]["default_count"])
        fk.setdefault("maintenance", (config.get("transporters") or {}).get("maintenance", True))
        out["forklifts"] = fk
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
        elif st.get("split") and pid in block_counts(scenario):
            errors.append(f"{pid}: 블록 공정에서는 나눠 하기를 쓸 수 없습니다(블록이 빈 작업장으로 퍼진다)")
        rule = st.get("dispatch", "ship")
        if rule not in DISPATCH_RULES:
            errors.append(f"{pid}: 우선순위 규칙(dispatch)은 {', '.join(DISPATCH_RULES)} 중 하나여야 합니다")
        elif rule != "ship" and pid not in block_counts(scenario):
            errors.append(f"{pid}: 우선순위 규칙은 블록 조립 실습의 블록 공정에서만 고를 수 있습니다")
        # 호이스트(4.9): 블록을 뒤집는 조립 정반(소조립·중조립)에만 단다
        if not isinstance(st.get("hoist", False), bool):
            errors.append(f"{pid}: 호이스트(hoist)는 true 또는 false여야 합니다")
        elif st.get("hoist") and not _station_rule(scenario, pid).get("hoist"):
            errors.append(f"{pid}: 호이스트는 {', '.join(hoist_stations(scenario))}에만 달 수 있습니다")
        # 공정 여유(4.15): 0~max_days일
        buf = st.get("buffer", 0)
        if not _is_int(buf) or not 0 <= buf <= scenario["plan_buffer"]["max_days"]:
            errors.append(f"{pid}: 공정 여유(buffer)는 0~{scenario['plan_buffer']['max_days']}일이어야 합니다")
        units = st.get("units", 1)
        # 탑재 도크는 골리앗 크레인(걸리버의 두 손)이 있어야 하므로 2곳까지(3.0)
        max_units = scenario["expansion"].get("max_units_by_station", {}).get(pid, scenario["expansion"]["max_units"])
        if not _is_int(units) or not 1 <= units <= max_units:
            why = " (도크마다 골리앗 크레인이 있어야 하는데, 크레인은 걸리버의 두 손뿐입니다)" if pid == scenario["stations"][-1]["id"] and max_units < scenario["expansion"]["max_units"] else ""
            errors.append(f"{pid}: 작업장 수는 1~{max_units}개여야 합니다{why}")

    # 직종별 대기소 인원(4.0, D42). 시운전도 직종이다(4.22, D69).
    pools = config.get("pools") or {}
    for tid in active_trades(scenario):
        info = scenario["trades"][tid]
        n = pools.get(tid)
        if not _is_int(n) or not 1 <= n <= info["max"]:
            errors.append(f"{info['name']} 인원은 1~{info['max']}명이어야 합니다")

    # 블록 트랜스포터(4.8): 1~max_count대. 4.7 이전 설정은 count가 없으면 1대(complete_config)
    tr = config.get("transporters") or {}
    if not _is_int(tr.get("count")) or not 1 <= tr["count"] <= scenario["transporter"]["max_count"]:
        errors.append(f"트랜스포터는 1~{scenario['transporter']['max_count']}대여야 합니다")
    if not isinstance(tr.get("maintenance"), bool):
        errors.append("트랜스포터 정비는 true 또는 false여야 합니다")
    # 공용 지게차(4.3, D46): 1~max_count대
    if "forklift" in scenario:
        fk = config.get("forklifts") or {}
        if not _is_int(fk.get("count")) or not 1 <= fk["count"] <= scenario["forklift"]["max_count"]:
            errors.append(f"지게차는 1~{scenario['forklift']['max_count']}대여야 합니다")
        if not isinstance(fk.get("maintenance"), bool):
            errors.append("지게차 정비는 true 또는 false여야 합니다")

    queue = config.get("research", [])
    if not isinstance(queue, list) or any(r not in scenario["research"] for r in queue):
        errors.append(f"연구는 {', '.join(scenario['research'])} 중에서 골라야 합니다")
    elif len(set(queue)) != len(queue):
        errors.append("같은 연구를 두 번 넣을 수 없습니다")

    ordering = config.get("ordering")
    if ordering is not None and ordering not in scenario["ordering"]:
        errors.append(f"발주 방식은 {', '.join(scenario['ordering'])} 중 하나이거나 비워 둬야 합니다")

    # 안전 재고(4.14): 자재마다 levels 중 하나(척분)
    levels = scenario["safety_stock"]["levels"]
    ss = config.get("safety_stock", {})
    if not isinstance(ss, dict) or any(m not in material_ids or v not in levels for m, v in ss.items()):
        errors.append(f"안전 재고는 자재마다 {', '.join(map(str, levels))}척분 중 하나여야 합니다")

    # 역산 발주 여유일(4.13): 0~buffer_max일
    buffer = config.get("jit_buffer", 0)
    buffer_max = scenario["ordering"]["jit"]["buffer_max"]
    if not _is_int(buffer) or not 0 <= buffer <= buffer_max:
        errors.append(f"역산 발주 여유일은 0~{buffer_max}일이어야 합니다")

    # 공정·블록 납기(4.25, D71): 블록 조립 실습에서만. 적은 것만 기본값(역산)을 바꾼다
    due = config.get("due")
    if due is not None:
        active_ids = [s["id"] for s in scenario["stations"] if not is_skipped(s)]
        valid_blocks = set(block_ids(scenario))
        ok_day = lambda d: _is_int(d) and 1 <= d <= days
        if not block_counts(scenario):
            errors.append("공정·블록 납기는 블록 조립 실습에서만 정할 수 있습니다")
        elif not isinstance(due, dict) or set(due) - {"stations", "blocks"}:
            errors.append("납기(due)는 stations(배 → 공정 → 날)와 blocks(블록 → 날)만 적을 수 있습니다")
        else:
            for sid, per in (due.get("stations") or {}).items():
                if sid not in order_ids or not isinstance(per, dict):
                    errors.append(f"공정 납기: {sid}는 수주에 없는 배입니다")
                    continue
                for pid, d in per.items():
                    if pid not in active_ids:
                        errors.append(f"{sid}: 공정 납기의 {pid}는 이 분기에서 쓰지 않는 공정입니다")
                    elif not ok_day(d):
                        errors.append(f"{sid}: {pid} 공정 납기는 1~{days} 사이의 정수여야 합니다")
            for bid, d in (due.get("blocks") or {}).items():
                if bid not in valid_blocks:
                    errors.append(f"블록 납기: {bid}는 없는 블록입니다")
                elif not ok_day(d):
                    errors.append(f"{bid}: 블록 납기는 1~{days} 사이의 정수여야 합니다")

    # 블록 순서(4.25): 블록 공정마다 먼저 할 블록 목록(계획 간트에서 끌어 정한다). 그 공정의 블록만, 한 번씩
    border = config.get("block_order")
    if border is not None:
        bst = block_counts(scenario)
        if not bst:
            errors.append("블록 순서(block_order)는 블록 조립 실습에서만 정할 수 있습니다")
        elif not isinstance(border, dict):
            errors.append("블록 순서(block_order)는 공정 → 블록 이름 목록이어야 합니다")
        else:
            for pid, ids in border.items():
                own = {block_id(o["id"], pid, k) for o in scenario["orders"] for k in range(1, bst.get(pid, 0) + 1)}
                if pid not in bst:
                    errors.append(f"블록 순서: {pid}는 블록 공정이 아닙니다")
                elif not isinstance(ids, list) or len(set(ids)) != len(ids) or any(b not in own for b in ids):
                    errors.append(f"블록 순서: {pid}에는 그 공정의 블록 이름을 한 번씩만 적어야 합니다")

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
    options가 없는 시나리오(손 계산용 등)는 모두 열려 있다. hoist(4.9)가 없으면 호이스트는 닫혀 있다.
    """
    opts = scenario.get("options")
    if not opts:
        return []
    name = scenario.get("name", "이 분기")
    rules = scenario["rules"]
    errors: list[str] = []
    for st in scenario["stations"]:
        pid, label = st["id"], st["name"]
        if is_skipped(st):
            continue
        cfg = config["stations"][pid]
        crew = crew_of(config, pid)
        if crew != "trial" and crew not in opts["crews"]:
            errors.append(f"{name}에서는 인력 '{rules['crews'][crew]['name']}'을(를) 쓸 수 없습니다({label})")
        if cfg["method"] not in opts["methods"]:
            errors.append(f"{name}에서는 공법 '{rules['methods'][cfg['method']]['name']}'을(를) 쓸 수 없습니다({label})")
        if cfg.get("units", 1) > opts["max_units"]:
            errors.append(f"{name}에서는 작업장을 {opts['max_units']}개까지 둘 수 있습니다({label})")
        if cfg.get("split", False) and not opts["split"]:
            errors.append(f"{name}에서는 나눠 하기를 쓸 수 없습니다({label})")
        if cfg.get("hoist", False) and not opts.get("hoist", False):
            errors.append(f"{name}에서는 호이스트를 쓸 수 없습니다({label})")
        if cfg.get("buffer", 0) and not opts.get("plan_buffer", False):
            errors.append(f"{name}에서는 공정 여유를 둘 수 없습니다({label})")
    # 시운전 인원(4.22): 분기가 고정했으면(간이공정 1명) 그 값만
    trial_pools = opts.get("trial_pools")
    if trial_pools and (config.get("pools") or {}).get("trial") not in trial_pools:
        errors.append(f"{name}에서는 시운전 인원을 {', '.join(map(str, trial_pools))}명으로만 둘 수 있습니다")
    tcounts = opts.get("transporter_counts")
    if tcounts and (config.get("transporters") or {}).get("count") not in tcounts:
        errors.append(f"{name}에서는 트랜스포터를 {', '.join(map(str, tcounts))}대로만 둘 수 있습니다")
    counts = opts.get("forklift_counts")
    if counts and (config.get("forklifts") or {}).get("count") not in counts:
        errors.append(f"{name}에서는 지게차를 {', '.join(map(str, counts))}대로만 둘 수 있습니다")
    if any((config.get("safety_stock") or {}).values()) and not opts.get("safety_stock"):
        errors.append(f"{name}에서는 안전 재고를 둘 수 없습니다")
    if config.get("jit_buffer", scenario["ordering"]["jit"]["buffer_days"]) != scenario["ordering"]["jit"]["buffer_days"] and not opts.get("jit_buffer"):
        errors.append(f"{name}에서는 역산 발주 여유일을 바꿀 수 없습니다")
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
    trade = _trade_of_station(station_id)
    if trade == "trial":
        return "trial"   # 시운전팀(4.22): 대기소 시운전 직종. 숙련공·로봇을 고르지 않는다
    if crew is not None:
        return crew
    return "skilled" if config.get("skilled_station") == station_id else "normal"


_STATION_TRADE: dict[str, str] = {}


def _trade_of_station(station_id: str) -> str:
    """공정의 직종(rules.json). 손 계산용 시나리오도 같은 공정 id를 쓴다."""
    if not _STATION_TRADE:
        for st in _read(DATA_DIR / "rules.json")["stations"]:
            _STATION_TRADE[st["id"]] = st.get("trade", "assembly")
    return _STATION_TRADE.get(station_id, "assembly")


def material_grade(config: dict[str, Any], material_id: str | None) -> str:
    """자재 등급: standard(표준) 또는 cheap(저가). 설정에 없으면 표준."""
    return (config.get("materials") or {}).get(material_id, "standard") if material_id else "standard"


def _station_rule(scenario: dict[str, Any], station_id: str) -> dict[str, Any]:
    return next((s for s in scenario["stations"] if s["id"] == station_id), {})


def hoist_stations(scenario: dict[str, Any]) -> list[str]:
    """호이스트를 달 수 있는 공정의 이름(rules.json 공정의 hoist)."""
    return [s["name"] for s in scenario["stations"] if s.get("hoist")]


def has_hoist(config: dict[str, Any], station_id: str) -> bool:
    """호이스트(4.9): 그 공정의 모든 작업장에 단 천장 크레인. 설정에 없으면 없다."""
    return bool(config["stations"][station_id].get("hoist", False))


def station_work(config: dict[str, Any], scenario: dict[str, Any], station_id: str, ship_type: str) -> float:
    """배 한 척이 그 공정에서 할 작업량. 호이스트가 있으면 블록을 들고 뒤집는 시간이 줄어 work_factor배."""
    work = scenario["ship_types"][ship_type]["work"][station_id]
    if has_hoist(config, station_id):
        work *= scenario["rules"]["hoist"]["work_factor"]
    return work


def is_overtime(station_cfg: dict[str, Any]) -> bool:
    """잔업은 사람이 하는 일이다. 로봇 공정은 잔업을 켜도 하지 않는다. 시운전(바다)도 하지 않는다."""
    return station_cfg["overtime"] and station_cfg.get("crew") not in ("robot", "trial")


def station_rate(station_cfg: dict[str, Any], rules: dict[str, Any], assigned: int, worker_factor: float = 1) -> float:
    """하루 처리량 = min(배정 인원 × 자동화 배수, 설비 수용 인원) × 공법 속도 × 잔업 계수. 로봇은 정해진 인원분."""
    speed = rules["methods"][station_cfg["method"]]["speed"]
    if station_cfg.get("crew") == "robot":
        return rules["crews"]["robot"]["rate"] * speed
    workers = min(assigned * worker_factor, rules["max_workers_per_station"])
    overtime = rules["overtime"]["speed"] if is_overtime(station_cfg) else 1.0
    return workers * speed * overtime


def station_defect_rate(station_cfg: dict[str, Any], crew: str, scenario: dict[str, Any],
                        research: frozenset[str] = frozenset(), lots_done: int = 0, grade: str = "standard",
                        equipment: bool = True) -> float:
    """불량률 = 공법(신공법은 끝낸 로트 수만큼 낮아짐) + 잔업 + 미정비 + 인력 + 자재 등급 − 자동 검사.

    예지 정비는 고장만 막는다(2.0). 정비를 안 한 공정의 불량 가산은 그대로다.

    research는 효과가 난 연구, lots_done은 이 공정에서 검사를 마친 로트 수(학습 곡선).
    equipment가 False인 공정(시운전, 4.12)은 설비가 없어 미정비 가산이 없다."""
    rules = scenario["rules"]
    method = rules["methods"][station_cfg["method"]]
    rate = method["defect_rate"]
    if "learning_step" in method:
        rate = max(method["defect_floor"], rate - method["learning_step"] * lots_done)
    if is_overtime({**station_cfg, "crew": crew}):
        rate += rules["overtime"]["defect_add"]
    if equipment and not station_cfg["maintenance"]:
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


def safety_stock(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, int]:
    """안전 재고 수량(4.14, D60): 자재마다 0·1·2척분. 1척분 = 이 분기 배 중 그 자재를 가장 많이 쓰는 배 한 척 몫.

    1일에 발주해 리드타임 뒤에 들어오는 공용 재고(몫 없음)다. 안전 재고 발주는 지연되지 않는다.
    자재비는 들지 않고 재고비만 낸다(남으면 다음 반기로 넘어간다).
    """
    levels = config.get("safety_stock") or {}
    types = {o["type"] for o in scenario["orders"]}
    return {m["id"]: levels.get(m["id"], 0) * max(scenario["ship_types"][t]["bom"].get(m["id"], 0) for t in types)
            for m in scenario["materials"] if levels.get(m["id"], 0)}


def material_abc(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """자재 ABC 분석(4.14, D60): 이 분기 수주 전체의 자재별 사용량·금액, ABC 등급, 쓰는 배 수(사용 빈도).

    금액(표준 단가) 큰 순으로 돌려준다. 누적 비율(cumulative)이 abc.A 이하면 A, abc.B 이하면 B, 나머지 C(첫 자재는 늘 A).
    금액이 큰 A는 엄격하게(재고를 적게), 금액이 작고 가끔 쓰는 C는 넉넉하게 관리한다는 교육용 표다. 규칙에는 쓰지 않는다.
    """
    cut = scenario["safety_stock"]["abc"]
    rows = []
    for m in scenario["materials"]:
        qty = [scenario["ship_types"][o["type"]]["bom"].get(m["id"], 0) for o in scenario["orders"]]
        if sum(qty) and any(st.get("material") == m["id"] for st in scenario["stations"]):
            rows.append({"material": m["id"], "name": m["name"], "quantity": sum(qty), "value": sum(qty) * m["price"],
                         "ships": sum(1 for q in qty if q), "of": len(qty), "lead_days": m["lead_days"], "delay": m.get("delay")})
    total = sum(r["value"] for r in rows) or 1
    rows.sort(key=lambda r: -r["value"])   # 금액 큰 순(파레토 차트 순서)
    acc = 0.0
    for k, r in enumerate(rows):
        acc += r["value"] / total
        r["share"] = round(r["value"] / total, 3)
        r["cumulative"] = round(acc, 3)
        r["class"] = "A" if k == 0 or acc <= cut["A"] + EPS else "B" if acc <= cut["B"] + EPS else "C"
    return rows


def plan_buffers(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, int]:
    """공정 여유(4.15, D62): 쓰는 공정마다 여유일. 설정에 없으면 0."""
    return {st["id"]: config["stations"][st["id"]].get("buffer", 0) for st in scenario["stations"] if not is_skipped(st)}


def contract_orders(config: dict[str, Any], scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """선주와 맺은 납기와 선가(4.15). 여유 합계만큼 납기가 늦어지고 선가가 하루 price_cut_per_day씩 준다.

    원래 값은 base_due_day·base_price에 남긴다(등급의 KPI 대상은 원래 납기로 가른다).
    """
    days = sum(plan_buffers(config, scenario).values())
    cut = scenario["plan_buffer"]["price_cut_per_day"]
    return [{**o, "base_due_day": o["due_day"], "base_price": o["price"], "buffer_days": days,
             "due_day": o["due_day"] + days, "price": round(o["price"] * (1 - cut * days), 2)}
            for o in scenario["orders"]]


def jit_buffer(config: dict[str, Any], scenario: dict[str, Any]) -> int:
    """역산 발주의 여유일(4.13, D59). 설정에 없으면 규칙의 기본값(0일)."""
    return config.get("jit_buffer", scenario["ordering"]["jit"]["buffer_days"])


def supply_delay_days(scenario: dict[str, Any], ship_id: str, material_id: str) -> int:
    """입고 지연(4.13, D59): 그 발주가 며칠 늦게 들어오는지. 시나리오가 supply_delays를 켜지 않았으면 0.

    난수표 random.supply[배][자재]가 그 자재의 delay.probability보다 작으면 delay.days일 늦다(4.14부터 자재마다 다르다, D60).
    표준품(종이)은 공급처가 많아 드물고 짧게, 특수품(LNG 보냉재)은 공급처가 하나라 잦고 길게 늦는다.
    """
    if not scenario.get("supply_delays"):
        return 0
    rule = next(m["delay"] for m in scenario["materials"] if m["id"] == material_id)
    r = scenario["random"].get("supply", {}).get(ship_id, {}).get(material_id, 1.0)
    return rule["days"] if r < rule["probability"] else 0


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
    if not st.get("split", True) or not config["stations"][st["id"]].get("split", False):
        return 1
    return min(units, MAX_PARTS)


def investment(config: dict[str, Any], scenario: dict[str, Any]) -> float:
    """설비 투자비: 증설한 작업장 + 로봇 도입(작업장마다) + 호이스트(작업장마다, 4.9) + 신공법 도입(공정마다)."""
    rules = scenario["rules"]
    total = 0.0
    for st, n in zip(scenario["stations"], station_units(config, scenario)):
        cfg = config["stations"][st["id"]]
        total += (n - 1) * scenario["expansion"]["cost"][st["id"]]
        if crew_of(config, st["id"]) == "robot":
            total += n * rules["crews"]["robot"]["install_cost"]
        if has_hoist(config, st["id"]):
            total += n * rules["hoist"]["install_cost"]
        total += rules["methods"][cfg["method"]].get("setup_cost", 0)
    return total


def material_prices(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, float]:
    """자재 단가. 저가 등급은 단가 × price_factor."""
    return {m["id"]: m["price"] * scenario["material_grades"][material_grade(config, m["id"])]["price_factor"]
            for m in scenario["materials"]}


def fixed_costs(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, float]:
    """실행 전에 정해지는 비용: 인건비(대기소), 정비비(작업장마다, 호이스트를 단 작업장은 호이스트 정비비도), 운반 설비(트랜스포터·지게차), 설비 투자비, 연구비."""
    costs = scenario["rules"]["costs"]
    tr = scenario["transporter"]
    days = scenario["days"]
    n_tr = config["transporters"]["count"]
    units = station_units(config, scenario)
    vehicles = 0.0
    if "forklift" in scenario:
        fk, n_fk = scenario["forklift"], config["forklifts"]["count"]
        vehicles = n_fk * fk["cost_per_day"] * days + (n_fk * fk["maintenance_cost"] if config["forklifts"]["maintenance"] else 0)
    return {
        "labor": sum(config["pools"].values()) * costs["wage_per_day"] * days,
        "maintenance": sum(n * (costs["maintenance_per_station"] + (scenario["rules"]["hoist"]["maintenance_cost"] if has_hoist(config, s["id"]) else 0))
                           for s, n in zip(scenario["stations"], units) if config["stations"][s["id"]]["maintenance"] and not is_skipped(s) and has_equipment(s)),
        "transporter": n_tr * tr["cost_per_day"] * days
        + (n_tr * tr["maintenance_cost"] if config["transporters"]["maintenance"] else 0) + vehicles,
        "investment": investment(config, scenario),
        "research": sum(scenario["research"][r]["cost"] for r in config.get("research", [])),
    }


def ship_specs(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """선박 사양서(4.17, D64): 배마다 쓰는 공정의 작업량(호이스트 반영)·직종·자재와 직종별 작업량 합계.

    작업량은 인·일(표준 공법 1명이 하루에 1)이다. 시운전은 직종 합계의 trial이다.
    설명용이고 규칙에는 쓰지 않는다.
    """
    out = {}
    for o in scenario["orders"]:
        bom = scenario["ship_types"][o["type"]]["bom"]
        rows, trades = [], {}
        for st in scenario["stations"]:
            if is_skipped(st):
                continue
            work = round(station_work(config, scenario, st["id"], o["type"]), 2)
            trade = st.get("trade", "assembly")
            mat = st["material"]
            rows.append({"station": st["id"], "trade": trade, "work": work,
                         "material": mat, "quantity": bom.get(mat, 0) if mat else 0})
            trades[trade] = round(trades.get(trade, 0) + work, 2)
        out[o["id"]] = {"type": o["type"], "stations": rows, "trades": trades}
    return out


def preview(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, Any]:
    """실행하지 않고 설정만으로 알 수 있는 값: 공정별 최대 처리량과 불량률, 고정비, 연구 일정."""
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    config = complete_config(config, scenario)
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
            "defect_rate": station_defect_rate(cfg, crew, scenario, grade=grade, equipment=has_equipment(st)),
            "defect_rate_final": station_defect_rate(cfg, crew, scenario, every, lots_done=len(scenario["orders"]), grade=grade,
                                                     equipment=has_equipment(st)),
        }
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    materials = {sid: {mid: {"order_day": day, "arrival_day": None if day is None else day + lead[mid]}
                       for mid, day in days.items()}
                 for sid, days in order_days.items()}
    return {"stations": stations, "fixed_costs": fixed_costs(config, scenario),
            "research": research_schedule(config.get("research", []), scenario),
            "materials": materials, "safety_stock": safety_stock(config, scenario), "abc": material_abc(scenario),
            "plan": plan_schedule(config, scenario),
            # 선박 사양서(4.17): 배마다 공정별 작업량·직종·자재
            "ships": ship_specs(config, scenario),
            # 공정 여유(4.15): 선주와 맺을 납기와 선가
            "contract": {o["id"]: {"due_day": o["due_day"], "price": o["price"], "buffer_days": o["buffer_days"]}
                         for o in contract_orders(config, scenario)},
            **_due_preview(config, scenario)}


def _due_preview(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """블록 조립 실습(4.25)의 미리보기: 공정·블록 납기와 계획상 위험(계획 간트 끝이 공정 납기를 넘기는 배·공정).
    계획상 위험은 실행 결과가 아니라 배가 혼자 쓴다고 본 계획 일정이다."""
    if not block_counts(scenario):
        return {}
    dues = station_dues(config, scenario)
    plan = plan_schedule(config, scenario)["ships"]
    risks = [{"ship": sid, "station": pid, "plan_end": span["end"], "due": dues[sid][pid], "days": span["end"] - dues[sid][pid]}
             for sid, spans in plan.items() for pid, span in spans.items() if span["end"] > dues[sid][pid]]
    return {"dues": {"stations": dues, "blocks": block_dues(config, scenario, dues)}, "plan_risks": risks,
            "block_plan": block_plan(config, scenario)}


def move_days_between(scenario: dict[str, Any], a: int, b: int) -> int:
    """공정 a를 끝내고 공정 b에 들어갈 수 있게 되기까지(4.0, D41). 끝난 다음 날이 1.

    같은 자리(site)면 운반 없이 다음 날, b가 크레인(탑재)·예인(안벽의장·시운전)·컨베이어벨트(가공)·지게차(소조립, 부재 팔레트)로 받는 공정이면 다음 날,
    그 밖은 T2가 로트 무게를 하루 용량씩 나른다(다 나른 날 들어간다).
    """
    sa, sb = scenario["stations"][a], scenario["stations"][b]
    if sa.get("site") == sb.get("site") or sb.get("arrive") in ("crane", "tow", "conveyor", "forklift"):
        return 1
    tr = scenario["transporter"]
    return math.ceil(tr["lot_weight"] / tr["capacity"] - EPS)


def station_after(scenario: dict[str, Any]) -> list[list[int]]:
    """공정마다 앞 공정 번호들. after가 없는 옛 시나리오는 바로 앞 공정 하나."""
    ids = [s["id"] for s in scenario["stations"]]
    raw = [[ids.index(a) for a in s["after"]] if "after" in s else ([p - 1] if p else [])
           for p, s in enumerate(scenario["stations"])]
    skipped = {p for p, s in enumerate(scenario["stations"]) if is_skipped(s)}

    def through(p: int) -> list[int]:
        """앞 공정 p가 쓰지 않는 공정이면 그 앞 공정들로 건너뛴다(간이공정, 4.4)."""
        return [x for a in raw[p] for x in (through(a) if a in skipped else [a])]
    return [[] if p in skipped else sorted(set(through(p))) for p in range(len(scenario["stations"]))]


def block_counts(scenario: dict[str, Any]) -> dict[str, int]:
    """블록 조립(4.25)을 켠 시나리오의 블록 공정과 블록 수(소조립 8·중조립 4·PE장 2). 끈 시나리오는 빈 dict.
    블록 공정은 조립 직종 공정이다. 절단·가공·도장의 blocks 값은 그림(조각 수)에만 쓴다."""
    if not scenario.get("block_mode"):
        return {}
    return {s["id"]: scenario["blocks"][s["id"]] for s in scenario["stations"]
            if not is_skipped(s) and s.get("trade") == "assembly" and scenario["blocks"].get(s["id"], 1) > 1}


def block_id(ship_id: str, station_id: str, no: int) -> str:
    """블록 이름(4.25): 배 + 공정 약자 + 번호. 예: S1-SA3(S1 소조립 3번 블록)."""
    return f"{ship_id}-{BLOCK_CODES.get(station_id, station_id[:2].upper())}{no}"


def block_ids(scenario: dict[str, Any]) -> list[str]:
    """블록 조립 실습의 모든 블록 이름(배 → 공정 → 번호 순). 끈 시나리오는 빈 목록."""
    return [block_id(o["id"], sid, k) for o in scenario["orders"] for sid, n in block_counts(scenario).items()
            for k in range(1, n + 1)]


def ideal_days(config: dict[str, Any], scenario: dict[str, Any], p: int, ship_type: str) -> int:
    """공정 납기 역산에 쓰는 이상 소요일(4.25): 작업량 ÷ (2명 × 공법 속도) ÷ min(작업장 수, 블록 수), 올림."""
    st = scenario["stations"][p]
    rules = scenario["rules"]
    cfg = config["stations"][st["id"]]
    rate = rules["max_workers_per_station"] * rules["methods"][cfg["method"]]["speed"]
    spread = min(cfg.get("units", 1), block_counts(scenario).get(st["id"], 1))
    return math.ceil(station_work(config, scenario, st["id"], ship_type) / rate / spread - EPS)


def remaining_ideal(config: dict[str, Any], scenario: dict[str, Any], p: int, ship_type: str) -> int:
    """여유(slack) 규칙의 남은 일: 공정 p와 그 뒤에 오는 모든 공정의 이상 소요일 합(이동일 없음, 4.25)."""
    after = station_after(scenario)
    later: set[int] = set()
    frontier = [p]
    while frontier:
        a = frontier.pop()
        for q, prev in enumerate(after):
            if a in prev and q not in later:
                later.add(q)
                frontier.append(q)
    return sum(ideal_days(config, scenario, q, ship_type) for q in {p} | later if not is_skipped(scenario["stations"][q]))


def block_sort_key(rule: str, order_pos: int | None, due: int, amount: float, slack: int, priority: int, no: int) -> tuple[Any, ...]:
    """블록을 들일 순서(4.25, 작을수록 먼저): 블록 순서 목록의 자리(없으면 목록 뒤) → 규칙 → 배 우선순위 → 블록 번호.
    실행(_run)과 블록 계획 일정(block_plan)이 같이 쓴다."""
    main: tuple[Any, ...] = {"edd": (due,), "slack": (slack,), "spt": (amount,)}.get(rule, ())
    return (order_pos if order_pos is not None else 1 << 30,) + main + (priority, no)


def block_plan(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """블록 계획 일정(4.25, D71): 생산계획서 계획 간트에서 공정을 펼치면 보이는 블록 막대.

    블록 공정마다 작업장 수만큼, 하루 처리량 2명 × 공법 속도로 이어 하기를 하며 들일 순서(block_sort_key)대로 놓는다.
    첫 블록 공정의 블록은 배의 계획 간트에서 그 공정을 시작하는 날, 다음 공정 블록은 앞 블록이 모두 끝난 다음 날부터
    들어갈 수 있다(블록은 하루에 다 실린다). 고장·사고·인력 대기·운반 대기는 넣지 않는 계획이다.
    돌려주는 것: blocks(블록 → 공정·배·시작·끝·작업장·납기·위험), order(공정 → 정한 목록 + 나머지는 시작 순),
    risks(끝 > 블록 납기)."""
    bst = block_counts(scenario)
    if not bst:
        return {}
    stations = scenario["stations"]
    ids = [s["id"] for s in stations]
    after = station_after(scenario)
    rules = scenario["rules"]
    plan = plan_schedule(config, scenario)["ships"]
    dues = block_dues(config, scenario)
    order_rank = {bid: k for lst in (config.get("block_order") or {}).values() for k, bid in enumerate(lst)}
    orders = contract_orders(config, scenario)
    out: dict[str, dict[str, Any]] = {}
    order_by_station: dict[str, list[str]] = {}
    for sid, n in bst.items():
        p = ids.index(sid)
        cfg = config["stations"][sid]
        rate = rules["max_workers_per_station"] * rules["methods"][cfg["method"]]["speed"]
        prev = next((ids[q] for q in after[p] if ids[q] in bst), None)
        rule = cfg.get("dispatch", "ship")
        todo = []
        for o in orders:
            r = bst[prev] // n if prev else 0
            for k in range(1, n + 1):
                bid = block_id(o["id"], sid, k)
                avail = (plan[o["id"]][sid]["start"] if prev is None
                         else max(out[block_id(o["id"], prev, c)]["end"] for c in range((k - 1) * r + 1, k * r + 1)) + 1)
                amount = station_work(config, scenario, sid, o["type"]) / n
                todo.append({"id": bid, "ship": o["id"], "no": k, "avail": avail, "left": amount, "amount": amount})
        rem = {o["id"]: remaining_ideal(config, scenario, p, o["type"]) for o in orders}
        due_of = {o["id"]: o["due_day"] for o in orders}
        prio = {o["id"]: config["ships"][o["id"]]["priority"] for o in orders}
        units: list[dict[str, Any] | None] = [None] * cfg.get("units", 1)
        started: list[str] = []
        day = min(b["avail"] for b in todo)
        while todo or any(units):
            for u in range(len(units)):
                cap = rate
                while cap > EPS:
                    if units[u] is None:
                        ready = [b for b in todo if b["avail"] <= day]
                        if not ready:
                            break
                        b = min(ready, key=lambda b: block_sort_key(rule, order_rank.get(b["id"]), dues[b["id"]], b["amount"],
                                                                    due_of[b["ship"]] - day - rem[b["ship"]], prio[b["ship"]], b["no"]))
                        todo.remove(b)
                        units[u] = b
                        b["start"] = day
                        started.append(b["id"])
                    b = units[u]
                    use = min(cap, b["left"])
                    b["left"] -= use
                    cap -= use
                    if b["left"] <= EPS:
                        out[b["id"]] = {"station": sid, "ship": b["ship"], "no": b["no"], "start": b["start"], "end": day,
                                        "unit": u + 1, "due": dues[b["id"]], "risk": day > dues[b["id"]]}
                        units[u] = None
            day += 1
        # 보이는 순서: 정한 목록(block_order)이 있으면 그 순서 그대로, 목록에 없는 블록은 그 뒤에 시작 순.
        # 목록 앞이어도 아직 닿지 않은 블록은 기다리지 않으므로, 막대가 목록 순서보다 늦게 그려질 수 있다
        listed = [bid for bid in (config.get("block_order") or {}).get(sid, []) if bid in out]
        order_by_station[sid] = listed + [bid for bid in started if bid not in listed]
    return {"blocks": out, "order": order_by_station,
            "risks": [bid for bid, b in out.items() if b["risk"]]}


def station_dues(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, dict[str, int]]:
    """배마다 공정 납기(4.25, D71). 마지막 공정 = 계약 납기, 앞 공정 = 뒤 공정 납기 − 뒤 공정 이상 소요일 − 이동일
    (뒤 공정이 둘 이상이면 가장 이른 값). 설정 due.stations에 적은 값은 그대로 쓰고, 그 앞 공정은 그 값에서 역산한다."""
    stations = scenario["stations"]
    after = station_after(scenario)
    active = [p for p, st in enumerate(stations) if not is_skipped(st)]
    overrides = (config.get("due") or {}).get("stations") or {}
    out: dict[str, dict[str, int]] = {}
    for order in contract_orders(config, scenario):
        due: dict[int, int] = {}
        for p in reversed(active):   # 공정 목록은 앞 공정이 늘 먼저다
            fixed = (overrides.get(order["id"]) or {}).get(stations[p]["id"])
            succ = [q for q in active if p in after[q]]
            if fixed is not None:
                due[p] = fixed
            elif not succ:
                due[p] = order["due_day"]
            else:   # 1일보다 앞서면 1일(그 공정은 계획상 위험으로 보인다)
                due[p] = max(1, min(due[q] - ideal_days(config, scenario, q, order["type"]) - move_days_between(scenario, p, q)
                                    for q in succ))
        out[order["id"]] = {stations[p]["id"]: due[p] for p in active}
    return out


def block_dues(config: dict[str, Any], scenario: dict[str, Any],
               dues: dict[str, dict[str, int]] | None = None) -> dict[str, int]:
    """블록 납기(4.25): 기본은 그 배의 공정 납기, 설정 due.blocks에 적은 블록은 그 값."""
    dues = dues if dues is not None else station_dues(config, scenario)
    overrides = (config.get("due") or {}).get("blocks") or {}
    out = {}
    for o in scenario["orders"]:
        for sid, n in block_counts(scenario).items():
            for k in range(1, n + 1):
                bid = block_id(o["id"], sid, k)
                out[bid] = overrides.get(bid, dues[o["id"]][sid])
    return out


def is_skipped(station: dict[str, Any]) -> bool:
    return bool(station.get("skipped"))


def has_equipment(station: dict[str, Any]) -> bool:
    """조선소 설비가 있는 공정. rules.json 공정의 equipment는 기본 설비 이름(4.12.1), 시운전(바다)은 false라
    고장·정비·미정비 불량이 없다(4.12)."""
    return station.get("equipment", True) is not False


def active_trades(scenario: dict[str, Any]) -> list[str]:
    """사람을 보내는 직종 가운데 쓰는 공정이 있는 직종(간이공정은 일부 직종이 빠진다). 4.22부터 시운전도 들어간다."""
    used = {st.get("trade", "assembly") for st in scenario["stations"] if not is_skipped(st)}
    return [t for t, info in scenario["trades"].items() if not t.startswith("_") and t in used]


def plan_schedule(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """계획 막대: 배마다 착수일부터 공정을 이어 붙인 일정과, 같은 작업장을 두 배가 겹쳐 쓰는 구간.

    배가 작업장과 사람을 혼자 쓰고 자재·설비가 멈추지 않는다고 본 일정이다(소요일 = 작업량 ÷ 처리량 올림,
    공정 사이는 운반일). 실제 실행에서는 겹친 구간만큼 뒤 순위 배가 작업장 대기를 한다.
    """
    rules = scenario["rules"]
    pools = config["pools"]
    units_of = dict(zip((s["id"] for s in scenario["stations"]), station_units(config, scenario)))
    parts_of = {s["id"]: split_parts(config, scenario, p, units_of[s["id"]]) for p, s in enumerate(scenario["stations"])}
    # 블록 조립(4.25): 블록이 빈 작업장으로 퍼지므로 블록 공정은 min(작업장 수, 블록 수)곳을 함께 쓴다고 본다
    for sid, n in block_counts(scenario).items():
        parts_of[sid] = min(units_of[sid], n)
    ships: dict[str, dict[str, dict[str, int]]] = {}
    buffers = plan_buffers(config, scenario)
    for order in scenario["orders"]:
        work = {st["id"]: station_work(config, scenario, st["id"], order["type"]) for st in scenario["stations"]}
        day = config["ships"][order["id"]]["start_day"]
        spans = {}
        # 공정 목록 순서(앞 공정을 늘 먼저 적는다)로 이어 붙인다. 도장·선행의장처럼 순서가 자유인 공정은 목록 순서대로.
        active = [p for p, st in enumerate(scenario["stations"]) if not is_skipped(st)]
        for k, p in enumerate(active):
            st = scenario["stations"][p]
            assigned = min(pools.get(st.get("trade", "assembly"), rules["max_workers_per_station"]), rules["max_workers_per_station"])
            rate = station_rate({**config["stations"][st["id"]], "crew": crew_of(config, st["id"])}, rules, assigned)
            # 나눠 하기: 작업장을 모두 쓴다고 보고 부분 작업량으로 잰다(배가 혼자 쓸 때의 일정).
            end = day + math.ceil(work[st["id"]] / parts_of[st["id"]] / rate - EPS) - 1
            spans[st["id"]] = {"start": day, "end": end, **({"buffer": buffers[st["id"]]} if buffers[st["id"]] else {})}
            # 끝난 다음 날부터 다음 공정으로(같은 자리·크레인·예인은 다음 날, 그 밖은 T2 운반일). 공정 여유(4.15)가 있으면 그 뒤로
            if k + 1 < len(active):
                day = end + buffers[st["id"]] + move_days_between(scenario, p, active[k + 1])
        ships[order["id"]] = spans

    # 겹침: 같은 공정을 쓰는 배가 그 공정의 작업장 수보다 많은 날. 두 배씩 묶어 그 날들의 구간으로 적는다.
    conflicts = []
    ids = list(ships)
    for st, n_units in zip(scenario["stations"], station_units(config, scenario)):
        sid = st["id"]
        if is_skipped(st):
            continue
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
    config = complete_config(config, scenario)
    result = _run(_with_order_days(config, scenario), scenario)
    base_cfg = _baseline_config(scenario) if baseline else None
    if base_cfg is not None:
        base_cfg = complete_config(normalize_config(base_cfg), scenario)
    base = _baseline_summary(base_cfg, scenario) if base_cfg is not None else None
    result["grade"] = _grade(result, config, base, base_cfg, scenario)
    # 7관리 지표(4.15)는 평가서 부록용이라 기준선 실행에는 붙이지 않는다
    result["management"] = _management(result, config, scenario)
    if block_counts(scenario):
        result["recommend"] = _recommend(config, scenario, result)
    return result


def _dispatch_metrics(result: dict[str, Any]) -> dict[str, Any]:
    """추천(4.25)이 비교하는 네 숫자: 인도 납기 준수 척 수, 블록 납기 준수율, 이익, 직행률."""
    return {"on_time": result["qcd"]["delivery"]["on_time"], "block_rate": result["block_due"]["rate"],
            "profit": result["profit"], "first_pass_yield": result["qcd"]["quality"]["first_pass_yield"]}


def _dispatch_rank(m: dict[str, Any]) -> tuple[Any, ...]:
    """D를 먼저(인도 납기 → 블록 납기), 그다음 C(이익)·Q(직행률). 클수록 좋다."""
    return (m["on_time"], m["block_rate"] or 0.0, m["profit"], m["first_pass_yield"] or 0.0)


def _recommend(config: dict[str, Any], scenario: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """평가서 선배의 팁의 우선순위 추천(4.25, D71): 블록 순서를 비우고 블록 공정의 규칙만 한 규칙으로 바꿔 4번 더
    돌려 비교한다. 나머지 설정은 그대로. 순위가 같으면 DISPATCH_RULES 순서. 실행 전 생산계획서에는 보이지 않는다."""
    bst = block_counts(scenario)
    rows = []
    for rule in DISPATCH_RULES:
        cfg = {**{k: v for k, v in config.items() if k != "block_order"},
               "stations": {sid: ({**st, "dispatch": rule} if sid in bst else st) for sid, st in config["stations"].items()}}
        rows.append({"rule": rule, **_dispatch_metrics(_run(_with_order_days(cfg, scenario), scenario))})
    best = max(rows, key=_dispatch_rank)   # 같으면 앞 규칙(max는 처음 만난 것)
    current = {"rules": {sid: config["stations"][sid].get("dispatch", "ship") for sid in bst},
               "block_order": bool(config.get("block_order")), **_dispatch_metrics(result)}
    return {"rules": rows, "best": best["rule"], "current": current,
            "current_is_best": _dispatch_rank(current) >= _dispatch_rank(best)}


def _baseline_config(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """기준선 프리셋 설정. 시나리오의 배가 프리셋과 다르면(손 계산용 시나리오 등) 없다."""
    pid = scenario["grade"]["baseline_preset"]
    preset = next((p for p in load_presets(scenario.get("id", DEFAULT_SCENARIO)) if p["id"] == pid), None)
    if preset is None:
        return None
    if set(preset["config"]["ships"]) != {o["id"] for o in scenario["orders"]}:
        return None
    return preset["config"]


# 기준선 캐시(4.16.2): 엔진이 결정적이라 기준선 결과는 시나리오와 기준선 설정만으로 정해진다.
# 채점마다 다시 돌리지 않고 등급에 쓰는 값만 남겨 둔다. 키는 시나리오·설정의 내용 전체라서
# rules.json·시나리오 파일·프리셋을 고치거나 테스트가 시나리오를 바꿔 넘기면 키가 달라져 새로 계산한다.
# 엔진 코드를 고치면 프로세스를 다시 띄우므로(서버 재시작) 메모리 캐시도 함께 비워진다.
_BASELINE_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_BASELINE_CACHE_SIZE = 16   # 시나리오 4개 + 테스트가 바꿔 넘기는 시나리오. 넘치면 오래 안 쓴 것부터 버린다
_BASELINE_LOCK = threading.Lock()   # 서버는 요청마다 스레드(ThreadingHTTPServer)


def _baseline_key(base_cfg: dict[str, Any], scenario: dict[str, Any]) -> str | None:
    try:
        text = json.dumps([scenario, base_cfg], sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        return None   # JSON으로 못 적는 값이 섞인 시나리오는 캐시하지 않는다
    return hashlib.sha256(text.encode()).hexdigest()


def _baseline_summary(base_cfg: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """기준선 실행에서 등급에 쓰는 값(점수, 등급, 이익, 납기 준수 척수). 같은 내용이면 캐시에서 꺼낸다."""
    key = _baseline_key(base_cfg, scenario)
    if key is not None:
        with _BASELINE_LOCK:
            hit = _BASELINE_CACHE.get(key)
            if hit is not None:
                _BASELINE_CACHE.move_to_end(key)
                return dict(hit)   # 꺼낸 쪽이 고쳐도 캐시는 그대로
    base = _run(_with_order_days(base_cfg, scenario), scenario)
    g = _grade(base, base_cfg, None, None, scenario)
    summary = {"score": g["score"], "grade": g["grade"], "profit": base["profit"],
               "on_time": base["qcd"]["delivery"]["on_time"]}
    if key is not None:
        with _BASELINE_LOCK:
            _BASELINE_CACHE[key] = summary
            while len(_BASELINE_CACHE) > _BASELINE_CACHE_SIZE:
                _BASELINE_CACHE.popitem(last=False)
    return dict(summary)


def clear_baseline_cache() -> None:
    """기준선 캐시를 비운다. 실행 중에 엔진 규칙을 코드로 바꾸는 경우(시험용)."""
    with _BASELINE_LOCK:
        _BASELINE_CACHE.clear()


def _run(config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    config = complete_config(normalize_config(config), scenario)
    validate_config(config, scenario)

    days: int = scenario["days"]
    rules = scenario["rules"]
    costs = rules["costs"]
    ot = rules["overtime"]
    bd = scenario["breakdown"]
    tr = scenario["transporter"]
    rnd = scenario["random"]
    orders = contract_orders(config, scenario)
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
    # 직종(4.0, D42): 공정마다 직종, 직종마다 대기소 인원. 시운전도 대기소의 시운전 직종이 한다(4.22, D69).
    trade_of = [s.get("trade", "assembly") for s in stations]
    pools: dict[str, int] = dict(config["pools"])
    pool: int = sum(pools.values())
    after = station_after(scenario)
    # 블록 트랜스포터 1~2대(4.8). 자재 키트와 가공 → 소조립 부재 팔레트는 공용 지게차(작업자 대기소처럼 대수를 고른다).
    n_tr: int = config["transporters"]["count"]
    tr_maintained: bool = config["transporters"]["maintenance"]
    fk = scenario["forklift"]
    n_fk: int = config["forklifts"]["count"]
    fk_maintained: bool = config["forklifts"]["maintenance"]
    schedule = research_schedule(config.get("research", []), scenario)
    automation = scenario["research"]["automation"]
    # 고장 판정 간격(일한 날): 호이스트를 단 공정은 설비가 하나 더 있어 더 자주 판정한다(4.9)
    every_busy = [rules["hoist"]["breakdown_every_busy_days"] if has_hoist(config, s["id"]) else bd["every_busy_days"] for s in stations]
    equipped = [has_equipment(s) for s in stations]

    stations_ids = [s["id"] for s in stations]

    def work_of(ship: int, p: int) -> float:
        return station_work(config, scenario, stations[p]["id"], orders[ship]["type"])

    def bom_of(ship: int, material: str) -> int:
        return types[orders[ship]["type"]]["bom"].get(material, 0)

    # 우선순위 숫자가 작은 배부터 본다. 운반, 투입, 인원 배정이 모두 이 순서다.
    priority = [config["ships"][o["id"]]["priority"] for o in orders]
    by_priority = sorted(range(n_ships), key=lambda i: priority[i])

    # 입고 일정: 발주일 + 리드타임 = 입고일.
    # order_days는 결과에 싣는 배별 발주일(필요 없는 자재와 비운 칸은 뺀다).
    # 입고 지연(4.13, D59): 시나리오가 켠 분기에서 발주마다 난수표(random.supply)로 정한다. 지연되면 그만큼 늦게 들어온다.
    arrivals: dict[int, list[tuple[str, int, str | None]]] = {}
    order_days: list[dict[str, int]] = [{} for _ in orders]
    arrival_day: list[dict[str, int]] = [{} for _ in orders]
    delay_notes: dict[int, list[dict[str, Any]]] = {}      # 원래 입고일 → 그날 알게 되는 지연
    # 안전 재고(4.14): 1일에 발주해 1 + 리드타임일에 공용 몫(None)으로 들어온다
    safety = safety_stock(config, scenario)
    for mid, qty in safety.items():
        arrivals.setdefault(1 + materials[mid]["lead_days"], []).append((mid, qty, None))
    for i, order in enumerate(orders):
        for mid, day in (config["ships"][order["id"]].get("order_days") or {}).items():
            qty = bom_of(i, mid)
            if day is None or qty == 0:
                continue
            order_days[i][mid] = day
            arrive = day + materials[mid]["lead_days"]
            late = supply_delay_days(scenario, order["id"], mid)
            if late:
                delay_notes.setdefault(arrive, []).append({"day": arrive, "type": "supply_delay", "material": mid, "ship": order["id"],
                                                           "quantity": qty, "days": late, "arrival_day": arrive + late})
            arrival_day[i][mid] = arrive + late
            arrivals.setdefault(arrive + late, []).append((mid, qty, order["id"]))

    # 처음 재고는 몫이 없는 공용이다(안전 재고는 위 입고 일정으로 들어온다, 4.14)
    stock = {mid: scenario.get("initial_stock", {}).get(mid, 0) for mid in materials}
    # 자재 페깅(3.1, 기록만): 창고의 자재를 입고 묶음 [입고일, 몫인 배, 수량]으로도 들고 있다. 처음 재고는 몫이 없다(공용).
    # 규칙은 그대로 공용 재고(stock)를 본다. 묶음은 "누구 몫을 누가 썼나"를 결과에 남기려는 것뿐이다.
    batches: dict[str, list[list[Any]]] = {mid: ([[0, None, stock[mid]]] if stock[mid] else []) for mid in materials}
    skipped_p = {p for p, st in enumerate(stations) if is_skipped(st)}       # 쓰지 않는 공정(4.4 간이공정): 처음부터 마친 것
    done: list[set[int]] = [set(skipped_p) for _ in range(n_ships)]   # 마친 공정(4.0: 공정 그래프)

    def _candidates(i: int) -> list[int]:
        return [q for q in range(n_st) if q not in done[i] and all(a in done[i] for a in after[q])]
    # 투입 단계가 매일 공정·배마다 묻기 때문에 저장해 두고, 공정을 마칠 때(finish)만 다시 구한다(속도만, 결과는 같다).
    cand: list[list[int]] = [_candidates(i) for i in range(n_ships)]

    def candidates(i: int) -> list[int]:
        """배가 지금 들어갈 수 있는 공정: 앞 공정을 모두 마쳤고 아직 안 한 공정(목록 순서)."""
        return cand[i]

    def finish(i: int, p: int) -> None:
        done[i].add(p)
        cand[i] = _candidates(i)
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
    fk_moves = [0] * n_fk
    fk_stop_until = [0] * n_fk
    # 자재 키트(4.0): 배 한 척이 한 공정에 쓸 자재 전량. (배, 공정) → 요청한 날. 실은(도착한) 키트는 kit_ready.
    # 요청: 앞 공정에 들어간 날. 지게차가 요청 다음 날부터 싣는다(4.3).
    kit_since: dict[tuple[int, int], int] = {}
    kit_ready: set[tuple[int, int]] = set()

    # 강재 적치장 자재(종이 = 철판, 4.2)는 키트가 아니라 들어가는 날 컨베이어로 받는다
    steel = {m["id"] for m in scenario["materials"] if m.get("store") == "steel_yard"}

    def request_kit(i: int, p: int, day: int) -> None:
        mid = stations[p]["material"] if p < n_st else None
        if mid and mid not in steel and bom_of(i, mid) > 0 and (i, p) not in kit_since:
            kit_since[(i, p)] = day

    # 앞 공정이 없는 공정(소조립)의 키트는 착수 예정일 하루 전에 요청한다
    for i, o in enumerate(orders):
        for q in range(n_st):
            if not after[q] and q not in skipped_p:
                request_kit(i, q, config["ships"][o["id"]]["start_day"] - 1)

    def advance(i: int, p: int, day: int) -> None:
        """배가 공정 p를 모두 마쳤다(finish 뒤). 다음 공정으로 보내거나, 마지막 공정이면 인도한다."""
        nxt = candidates(i)
        if not nxt:
            delivered[i] = day
            events.append({"day": day, "type": "delivery", "ship": orders[i]["id"],
                           "late_days": max(0, day - orders[i]["due_day"])})
        elif stations[nxt[0]].get("arrive") == "forklift":
            # 가공 → 소조립(4.3): 부재 팔레트를 공용 지게차가 실은 날 들어간다(다음 날부터 지게차를 기다린다)
            transit[i] = {"from": p, "to": nxt[0], "since": day, "by": "forklift"}
        elif move_days_between(scenario, p, nxt[0]) == 1:
            # 같은 자리(도장 ↔ 선행의장), 크레인(PE장 → 탑재), 예인(탑재 → 안벽의장 → 시운전): 다음 날
            ready[i] = day + 1
        else:
            transit[i] = {"from": p, "to": nxt[0], "since": day, "left": float(tr["lot_weight"]), "moving": False}

    # ----- 블록 조립(4.25, D71): 시나리오가 block_mode를 켠 실습에서만 -----
    # 소조립·중조립·PE장은 배 한 척의 로트 대신 블록(rules.json blocks: 8·4·2)으로 계산한다.
    # 블록 하나의 작업량 = 공정 작업량 ÷ 블록 수. 작업장 하나에 블록 하나씩 차례로 하고, 블록을 끝내고 남은
    # 하루 처리량은 같은 날 그 작업장의 다음 블록에 이어 쓴다(이어 하기). 다음 공정 블록 k는 앞 공정 블록
    # (k−1)·r+1 … k·r(r = 앞 블록 수 ÷ 이 블록 수)이 모두 닿은 날 들어갈 수 있다. 먼저 닿은 블록은 짝 대기.
    # 블록 상태: pending(앞 블록 기다림) → wait(들어갈 수 있음) → in(작업장 안) → await_tr(운반 대기)·moving(다음 날 도착)
    #            → pair(닿아서 짝 대기) → merged(다음 공정 블록이 됨). 마지막 블록 공정에서 끝나면 finished.
    block_mode = bool(scenario.get("block_mode"))
    n_blk = [block_counts(scenario).get(s["id"], 1) for s in stations]
    block_set = {p for p in range(n_st) if n_blk[p] > 1}
    block_prev = {p: next((q for q in after[p] if q in block_set), None) for p in block_set}
    block_next = {q: p for p, q in block_prev.items() if q is not None}
    block_first = sorted(p for p in block_set if block_prev[p] is None)
    ship_blocks: dict[int, dict[int, list[dict[str, Any]]]] = {}   # 배 → 공정 → 블록(번호 순)
    all_blocks: list[dict[str, Any]] = []
    block_tr_jobs: dict[int, list[str]] = {}                        # 오늘 트랜스포터가 실은 블록(대별)

    # 우선순위 규칙과 서두름(4.25). 여유(slack) = 인도 납기 − 오늘 − 이 공정과 뒤 공정의 이상 소요일 합
    dispatch = {p: config["stations"][stations[p]["id"]].get("dispatch", "ship") for p in block_set}
    order_rank = {bid: k for ids in (config.get("block_order") or {}).values() for k, bid in enumerate(ids)}
    rem_ideal = {(i, p): remaining_ideal(config, scenario, p, orders[i]["type"]) for i in range(n_ships) for p in block_set}
    sdues = station_dues(config, scenario) if block_mode else {}
    bdues = block_dues(config, scenario, sdues) if block_mode else {}

    def create_blocks(i: int, day: int) -> None:
        """배가 첫 블록 공정에 들어갈 수 있게 된 날, 모든 블록 공정의 블록을 만든다. 첫 블록 공정 블록은 바로 wait."""
        ship_blocks[i] = {}
        for p in sorted(block_set):
            amount = work_of(i, p) / n_blk[p]
            ship_blocks[i][p] = []
            for k in range(1, n_blk[p] + 1):
                bid = block_id(orders[i]["id"], stations[p]["id"], k)
                b = {"id": bid, "ship": i, "p": p, "no": k, "due": bdues[bid],
                     "state": "wait" if p in block_first else "pending", "avail": day if p in block_first else None,
                     "amount": amount, "unit": None, "start": None, "end": None, "done_day": None,
                     "verdict": None, "today": None, "daily": [{"state": NOT_STARTED, "unit": None}] * (day - 1)}
                ship_blocks[i][p].append(b)
                all_blocks.append(b)

    def block_key(b: dict[str, Any], day: int) -> tuple[Any, ...]:
        """블록 우선순위(4.25): 블록 순서(목록에 있으면 그 자리) → 그 공정의 규칙 → 배 우선순위 → 블록 번호."""
        i, p = b["ship"], b["p"]
        return block_sort_key(dispatch[p], order_rank.get(b["id"]), b["due"], b["amount"],
                              orders[i]["due_day"] - day - rem_ideal[(i, p)], priority[i], b["no"])

    def parent_of(b: dict[str, Any]) -> dict[str, Any]:
        """b가 닿아서 만들 다음 블록 공정의 블록."""
        nxt = block_next[b["p"]]
        return ship_blocks[b["ship"]][nxt][(b["no"] - 1) // (n_blk[b["p"]] // n_blk[nxt])]

    def pick_block(p: int, day: int) -> dict[str, Any] | None:
        """공정 p에 지금 들일 블록. 그 배의 자재 키트가 아직이면 자재 대기로 적고 다음 블록을 본다."""
        waiting = [b for i in by_priority if i in ship_blocks for b in ship_blocks[i][p]
                   if b["state"] == "wait" and b["avail"] <= day]
        for b in sorted(waiting, key=lambda b: block_key(b, day)):
            if (b["ship"], p) in kit_since and (b["ship"], p) not in kit_ready:
                b["today"] = (MATERIAL_WAIT, None)
                continue
            return b
        return None

    def enter_block(b: dict[str, Any], p: int, u: int, day: int) -> None:
        i, pid = b["ship"], stations[p]["id"]
        b.update(state="in", unit=u, start=day, today=None)
        current[p][u] = {"ship": i, "block": b, "remaining": b["amount"], "amount": b["amount"], "rework": False}
        if pid not in spans[i]:
            # 배의 그 공정 첫 블록: 투입 기록, 뒤 공정 키트 요청은 배 한 척에 한 번(로트와 같다)
            spans[i][pid] = {"start": day, "end": day}
            events.append({"day": day, "type": "enter", "ship": orders[i]["id"], "station": pid, "unit": u + 1, "block": b["id"]})
            for q in range(n_st):
                if p in after[q]:
                    request_kit(i, q, day)
            if not after[p]:   # 블록 공정이 첫 공정이면(테스트 판) 첫 블록이 들어간 날이 착수
                started[i] = day

    def block_arrive(b: dict[str, Any], day: int) -> None:
        """블록이 다음 블록 공정 앞에 닿았다. 짝이 모두 닿았으면 다음 공정 블록이 들어갈 수 있다."""
        r = n_blk[b["p"]] // n_blk[block_next[b["p"]]]
        parent = parent_of(b)
        b["state"] = "pair"
        siblings = ship_blocks[b["ship"]][b["p"]][(parent["no"] - 1) * r: parent["no"] * r]
        if all(s["state"] == "pair" for s in siblings):
            for s in siblings:
                s["state"] = "merged"
                if s["today"] is None:   # 오늘 닿은 블록은 오늘 운반(또는 짝 대기)으로 적는다
                    s["today"] = (PAIR_WAIT, None)
            parent.update(state="wait", avail=day)

    def block_done(b: dict[str, Any], p: int, day: int, u: int) -> None:
        """블록 하나가 검사를 통과했다. 그 배의 이 공정 블록이 모두 끝났으면 배가 이 공정을 마친 것이다."""
        i = b["ship"]
        b.update(done_day=day)
        last = p not in block_next
        if last:
            b["state"] = "finished"
        elif move_days_between(scenario, p, block_next[p]) == 1:
            b.update(state="moving", arrive=day + 1)
        else:
            b["state"] = "await_tr"
        if all(x["done_day"] is not None for x in ship_blocks[i][p]):
            events.append({"day": day, "type": "complete", "ship": orders[i]["id"], "station": stations[p]["id"], "unit": u + 1})
            finish(i, p)
            if last:
                advance(i, p, day)

    def block_work(p: int, u: int, cap: float, day: int) -> tuple[str, int]:
        """작업장 u의 오늘 처리량 cap으로 블록을 차례로 한다(이어 하기). 오늘 상태(작업·재작업)와 마지막 배를 돌려준다."""
        nonlocal defects
        pid = stations[p]["id"]
        cur = current[p][u]
        new_work, last_ship = False, cur["ship"]
        while cur is not None and cap > EPS:
            b, i = cur["block"], cur["ship"]
            last_ship = i
            use = min(cap, cur["remaining"])
            cur["remaining"] -= use
            cap -= use
            new_work = new_work or not cur["rework"]
            b.update(today=(REWORK if cur["rework"] else WORK, u), end=day)
            spans[i][pid]["end"] = day
            if cur["remaining"] > EPS:
                break
            work_done[p] += cur["amount"]
            if not cur["rework"]:
                # 검사는 블록마다(난수 random.block_quality). 재작업비는 블록 하나에 재작업비 ÷ 블록 수
                inspections[p] += 1
                rate = station_defect_rate(st_cfg[p], crews[p], scenario, done_research, inspections[p] - 1, grades[p],
                                           has_equipment(stations[p]))
                b["verdict"] = rnd["block_quality"][orders[i]["id"]][pid][b["no"] - 1] < rate
                if b["verdict"]:
                    cost["rework"] += costs["rework_per_defect"] / n_blk[p]
                    defects += 1
                    events.append({"day": day, "type": "defect", "ship": orders[i]["id"], "station": pid, "unit": u + 1,
                                   "block": b["id"]})
                    ratio = (scenario["research"]["auto_inspect"]["rework_ratio"]
                             if "auto_inspect" in done_research else rules["rework_ratio"])
                    cur["remaining"] = cur["amount"] = b["amount"] * ratio
                    cur["rework"] = True
                    continue
                passes[p] += 1
            current[p][u] = None
            block_done(b, p, day, u)
            nb = pick_block(p, day) if cap > EPS else None
            if nb is not None:
                enter_block(nb, p, u, day)
            cur = current[p][u]
        return (WORK if new_work else REWORK), last_ship

    def block_today(b: dict[str, Any], day: int) -> tuple[str, int | None] | None:
        """블록의 오늘 상태. 아직 없거나 다음 공정 블록이 된 블록은 None(배 상태에 넣지 않는다)."""
        if b["today"] is not None:
            return b["today"]
        state = b["state"]
        if state == "wait":
            return (STATION_WAIT, None)
        if state == "await_tr":
            return (TRANSPORT_WAIT, None)
        if state == "moving":
            return (TRANSPORT, None)
        if state == "pair":
            return (PAIR_WAIT, None)
        if state == "in":
            return (STATION_WAIT, b["unit"])
        return None

    ship_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_ships)]
    station_daily: list[list[list[dict[str, Any]]]] = [[[] for _ in range(n)] for n in n_units]
    transporter_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_tr)]
    forklift_daily: list[list[dict[str, Any]]] = [[] for _ in range(n_fk)]
    workforce_daily: list[dict[str, int]] = []
    spans: list[dict[str, dict[str, int]]] = [{} for _ in range(n_ships)]
    inventory_daily: list[dict[str, int]] = []
    pegging_daily: list[dict[str, list[dict[str, Any]]]] = []   # 그날 끝의 창고 재고를 몫(배)별로
    inventory_value_daily: list[float] = []            # 그날 작업이 끝난 뒤 창고 재고 금액 (재고비의 기준)
    onsite_value_daily: list[float] = []               # 작업장 앞·적치장에 놓인 키트 금액: 출고했지만 아직 그 공정에 들이지 않은 자재(4.1)
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
    fk_breakdowns = [0] * n_fk
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

        # 1. 입고. 지연된 발주는 원래 입고일에 지연을 알린다(4.13)
        events.extend(delay_notes.get(day, []))
        for mid, qty, for_ship in arrivals.get(day, []):
            stock[mid] += qty
            batches[mid].append([day, for_ship, qty])
            events.append({"day": day, "type": "arrival", "material": mid, "quantity": qty, "ship": for_ship,
                           **({"safety": True} if for_ship is None else {})})

        # 2. 운반: 공용 지게차(4.3, D46)와 블록 트랜스포터. 멈춘(고장) 차는 일감을 받지 않는다.
        carried: dict[int, list[str]] = {k: [] for k in range(n_tr) if day > tr_stop_until[k]}
        # 2-0. 지게차 일감: 요청 다음 날부터의 자재 키트(물류창고 → 그 자재를 쓰는 작업장)와
        #      가공을 끝낸 다음 날부터의 부재 팔레트(가공 → 소조립). 배 우선순위 → 공정 순으로 줄 세워
        #      멈추지 않은 지게차가 번호 순으로 한 대에 하루 jobs_per_day건씩 맡는다.
        #      키트는 실을 때 창고에서 출고한다(페깅 출고도 이때). 재고가 모자라면 싣지 못하고 다음 일감을 본다.
        #      팔레트는 실은 날 소조립에 들어갈 수 있다(T2 블록처럼). 못 맡은 팔레트는 운반 대기, 키트는 자재 대기가 된다.
        fk_up = [k for k in range(n_fk) if day > fk_stop_until[k]]
        fk_jobs: dict[int, list[dict[str, Any]]] = {k: [] for k in fk_up}
        slots = [k for k in fk_up for _ in range(fk["jobs_per_day"])]
        jobs = [("kit", i, p) for (i, p), since in kit_since.items() if (i, p) not in kit_ready and since < day]
        jobs += [("pallet", i, lot["to"]) for i, lot in transit.items() if lot.get("by") == "forklift" and lot["since"] < day]
        for kind, i, p in sorted(jobs, key=lambda j: (priority[j[1]], j[2], j[0])):
            if not slots:
                break
            if kind == "kit":
                mid = stations[p]["material"]
                need = bom_of(i, mid)
                if stock[mid] < need:
                    continue
                k = slots.pop(0)
                stock[mid] -= need
                events.append({"day": day, "type": "issue", "material": mid, "quantity": need,
                               "ship": orders[i]["id"], "station": stations[p]["id"], "transporter": None,
                               "forklift": f"F{k + 1}", "from": _take_pegged(batches[mid], orders[i]["id"], need)})
                kit_ready.add((i, p))
                fk_jobs[k].append({"kind": "kit", "ship": orders[i]["id"], "station": stations[p]["id"], "material": mid})
            else:
                k = slots.pop(0)
                lot = transit.pop(i)
                ready[i] = day
                fk_jobs[k].append({"kind": "pallet", "ship": orders[i]["id"], "from": stations[lot["from"]]["id"],
                                   "station": stations[p]["id"]})
        for i, lot in transit.items():
            if lot.get("by") == "forklift" and lot["since"] < day:
                ship_state[i] = (TRANSPORT_WAIT, lot["from"], None)
        # 오늘 일한 지게차는 운행 일수를 세고, 정해진 간격마다 고장 판정을 한다(난수표는 지게차 번호만큼 밀어 읽는다).
        for k in range(n_fk):
            if k not in fk_jobs:
                forklift_daily[k].append({"state": BREAKDOWN_STOP, "jobs": []})
                continue
            if not fk_jobs[k]:
                forklift_daily[k].append({"state": "idle", "jobs": []})
                continue
            forklift_daily[k].append({"state": "move", "jobs": fk_jobs[k]})
            fk_moves[k] += 1
            if fk_moves[k] % fk["every_moves"] == 0:
                threshold = 0 if "predictive" in done_research else (
                    fk["threshold_maintained"] if fk_maintained else fk["threshold"])
                table = rnd["transporter_breakdown"]
                n = fk_moves[k] // fk["every_moves"]
                if table[(n - 1 + k) % len(table)] < threshold:
                    fk_stop_until[k] = day + fk["stop_days"]
                    cost["breakdown"] += fk["repair_cost"]
                    fk_breakdowns[k] += 1
                    events.append({"day": day, "type": "breakdown", "forklift": f"F{k + 1}"})

        # 2-1. T2 블록: 공정을 끝낸 다음 날부터 우선순위 순으로 나른다.
        #      하루에 capacity만큼 나르고, 로트를 다 나른 날 바로 다음 공정에 들어갈 수 있다.
        #      트랜스포터가 둘이면(4.8) 대마다 차례로 우선순위 순 로트를 싣되, 다른 트랜스포터가 오늘 실은 로트는 건너뛴다
        #      (두 대가 서로 다른 배를 함께 나른다). 한 대면 4.7까지와 같다.
        free = [k for k in range(n_tr) if k in carried]
        room = {k: float(tr["capacity"]) for k in free}
        took_by: dict[int, int] = {}
        for k in free:
            for i in by_priority:
                lot = transit.get(i)
                if lot is None or lot["since"] >= day or lot.get("by") == "forklift":
                    continue
                if took_by.get(i, k) != k:
                    continue
                take = min(room[k], lot["left"])
                if take <= EPS:
                    continue
                route = {"ship": orders[i]["id"], "from": stations[lot["from"]]["id"], "to": stations[lot["to"]]["id"]}
                if not lot["moving"]:
                    lot["moving"] = True
                    events.append({"day": day, "type": "transport_start", **route})
                room[k] -= take
                lot["left"] -= take
                carried[k].append(orders[i]["id"])
                took_by[i] = k
                if lot["left"] <= EPS:
                    del transit[i]
                    ready[i] = day
                    events.append({"day": day, "type": "transport_end", **route})
        for i in by_priority:
            lot = transit.get(i)
            if lot is None or lot["since"] >= day or lot.get("by") == "forklift":
                continue
            ship_state[i] = (TRANSPORT if i in took_by else TRANSPORT_WAIT, lot["from"], None)

        # 2-1b. 블록 운반(4.25): 블록을 끝낸 다음 날부터 블록 하나씩 싣는다(무게 = 로트 무게 ÷ 앞 공정 블록 수).
        #       우선순위 순으로, 오늘 남은 용량에 통째로 들어가는 트랜스포터(번호 순)에 싣고 다 나른 날 닿는다.
        #       같은 자리·크레인으로 넘어가는 블록(moving)은 끝난 다음 날 닿는다.
        if block_mode:
            block_tr_jobs = {k: [] for k in free}
            for b in all_blocks:
                if b["state"] == "moving" and b["arrive"] <= day:
                    block_arrive(b, day)
            # 운반 순서: 닿아서 만들 다음 공정 블록을 그 공정의 규칙으로 줄 세운 순서, 같으면 블록 번호
            for b in sorted((b for b in all_blocks if b["state"] == "await_tr" and b["done_day"] < day),
                            key=lambda b: (block_key(parent_of(b), day), b["no"])):
                weight = tr["lot_weight"] / n_blk[b["p"]]
                k = next((k for k in free if room[k] >= weight - EPS), None)
                if k is None:
                    continue
                room[k] -= weight
                sid = orders[b["ship"]]["id"]
                if sid not in carried[k]:
                    carried[k].append(sid)
                block_tr_jobs[k].append(b["id"])
                route = {"ship": sid, "from": stations[b["p"]]["id"], "to": stations[block_next[b["p"]]]["id"], "block": b["id"]}
                events.append({"day": day, "type": "transport_start", **route})
                events.append({"day": day, "type": "transport_end", **route})
                b["today"] = (TRANSPORT, None)
                block_arrive(b, day)

        # 2-2. 오늘 운행한 트랜스포터는 운행 횟수를 세고, 정해진 간격마다 고장 판정을 한다.
        for k in range(n_tr):
            if k not in carried:
                transporter_daily[k].append({"state": BREAKDOWN_STOP, "ships": []})
                continue
            if not carried[k]:
                transporter_daily[k].append({"state": "idle", "ships": []})
                continue
            transporter_daily[k].append({"state": "move", "ships": carried[k],
                                         **({"blocks": block_tr_jobs[k]} if block_tr_jobs.get(k) else {})})
            tr_moves[k] += 1
            if tr_moves[k] % tr["every_moves"] == 0:
                threshold = 0 if "predictive" in done_research else (
                    tr["threshold_maintained"] if tr_maintained else tr["threshold"])
                table = rnd["transporter_breakdown"]
                n = tr_moves[k] // tr["every_moves"]
                if table[(n - 1 + k) % len(table)] < threshold:   # 2호는 난수표를 한 칸 밀어 읽는다(4.8)
                    tr_stop_until[k] = day + tr["stop_days"]
                    cost["breakdown"] += tr["repair_cost"]
                    tr_breakdowns[k] += 1
                    events.append({"day": day, "type": "breakdown", "transporter": TRANSPORTER_IDS[k]})

        # 3. 투입: 공정 순서대로, 작업장 번호 순서대로 본다. 비어 있으면 우선순위 순으로 들어올 로트를 찾는다.
        for p in range(n_st):
            pid = stations[p]["id"]
            inside = {c["ship"] for c in current[p] if c}
            waiting = [i for i in by_priority
                       if delivered[i] is None and i not in transit and p in candidates(i) and ready[i] <= day
                       and i not in inside and i not in groups]
            if p in block_set:
                # 블록 공정(4.25): 배가 첫 블록 공정에 들어갈 수 있게 된 날 블록을 만들고, 작업장에는 블록을 들인다
                if p in block_first:
                    for i in waiting:
                        if i not in ship_blocks:
                            create_blocks(i, day)
                waiting = []
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
                        if "block" in cur:
                            cur["block"]["today"] = (cause, u)
                    station_today[p][u] = {"state": cause, "ship": orders[cur["ship"]]["id"] if cur else None, "workers": 0}
                    continue

                if p in block_set:
                    if cur is None:
                        b = pick_block(p, day)
                        if b is not None:
                            enter_block(b, p, u, day)
                        elif any(x["today"] and x["today"][0] == MATERIAL_WAIT for x in all_blocks if x["p"] == p):
                            material_wait[p] += 1
                            station_today[p][u] = {"state": MATERIAL_WAIT, "ship": None, "workers": 0}
                    continue

                # 3-2. 비어 있으면 로트를 들인다. 자재를 쓰는 공정은 그 배의 키트가 작업장에 닿아 있어야 한다(4.0).
                #      키트가 아직이면(재고 부족, T1이 바쁘거나 고장) 자재 대기다.
                if cur is None:
                    for i in waiting:
                        if i in entered or ship_state.get(i, ("",))[0] == MATERIAL_WAIT:
                            continue
                        if (i, p) in kit_since and (i, p) not in kit_ready:
                            ship_state[i] = (MATERIAL_WAIT, p, None)
                            continue
                        # 강재 적치장 자재(4.2): 들어가는 날 롤러 컨베이어로 출고. 모자라면 자재 대기
                        smid = stations[p]["material"]
                        if smid in steel and bom_of(i, smid) > 0:
                            need = bom_of(i, smid)
                            if stock[smid] < need:
                                ship_state[i] = (MATERIAL_WAIT, p, None)
                                continue
                            stock[smid] -= need
                            events.append({"day": day, "type": "issue", "material": smid, "quantity": need,
                                           "ship": orders[i]["id"], "station": pid, "transporter": None, "via": "conveyor",
                                           "from": _take_pegged(batches[smid], orders[i]["id"], need)})
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
                        # 투입 기록은 배 한 척에 하나. 나눠 들어갔으면 작업장 목록(units)을 함께 싣는다(3.0).
                        enter = {"day": day, "type": "enter", "ship": orders[i]["id"], "station": pid, "unit": parts[0] + 1}
                        if k > 1:
                            enter["units"] = [v + 1 for v in parts]
                        events.append(enter)
                        cur = current[p][u]
                        entered.add(i)
                        # 이 공정 뒤 공정들의 키트는 이 공정에 들어간 날 요청한다
                        for q in range(n_st):
                            if p in after[q]:
                                request_kit(i, q, day)
                        spans[i][pid] = {"start": day, "end": day}
                        if not after[p]:   # 첫 공정(처음 쓰는 공정)에 들어간 날이 착수
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
        # 직종마다 따로: 사람은 자기 직종 공정에만 간다.
        idle_by = dict(pools)
        assigned = [[0] * n for n in n_units]
        for p, u in sorted(((p, u) for p in range(n_st) for u in range(n_units[p])
                            if current[p][u] and day > stop_until[p][u] and crews[p] != "robot"),
                           key=lambda pu: priority[current[pu[0]][pu[1]]["ship"]]):
            t = trade_of[p]
            assigned[p][u] = min(need, idle_by.get(t, 0))
            idle_by[t] = idle_by.get(t, 0) - assigned[p][u]
        idle = sum(idle_by.values())
        man_days += pool - idle
        workforce_daily.append({"assigned": pool - idle, "idle": idle,
                                "trades": {t: {"assigned": pools[t] - idle_by[t], "idle": idle_by[t]} for t in pools}})

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
                if "block" in cur:
                    cur["block"]["today"] = (LABOR_WAIT, u)
                station_today[p][u] = {"state": LABOR_WAIT, "ship": orders[i]["id"], "workers": 0}
                continue

            rate_today = station_rate(st_cfg[p], rules, assigned[p][u], factor)
            if p in block_set:
                # 블록 공정(4.25): 오늘 처리량으로 블록을 차례로 끝내고 다음 블록에 이어 쓴다(검사·운반 준비까지)
                first_block = cur["block"]["id"]
                state, i = block_work(p, u, rate_today, day)
            else:
                cur["remaining"] -= rate_today
                state = REWORK if cur["rework"] else WORK
                spans[i][pid]["end"] = day
            if crews[p] == "skilled":
                cost["labor"] += assigned[p][u] * skilled_extra
            busy[p] += 1
            unit_busy[p][u] += 1
            put(i, (state, p, u))
            station_today[p][u] = {"state": state, "ship": orders[i]["id"], "workers": assigned[p][u]}
            if p in block_set:
                station_today[p][u]["blocks"] = [b["id"] for b in all_blocks if b["p"] == p and b["today"]
                                                 and b["today"][0] in (WORK, REWORK) and b["today"][1] == u] or [first_block]

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
            #      설비가 없는 공정(시운전, 4.12)은 판정하지 않는다.
            if equipped[p] and unit_busy[p][u] % every_busy[p] == 0 and day > stop_until[p][u]:
                threshold = 0 if "predictive" in done_research else (
                    bd["threshold_maintained"] if st_cfg[p]["maintenance"] else bd["threshold"])
                table = rnd["breakdown"][pid]
                n = unit_busy[p][u] // every_busy[p]
                if table[(n - 1 + u) % len(table)] < threshold:
                    stop_until[p][u] = day + bd["stop_days"]
                    stop_cause[p][u] = BREAKDOWN_STOP
                    cost["breakdown"] += bd["cost"]
                    station_breakdowns[p] += 1
                    unit_breakdowns[p][u] += 1
                    events.append({"day": day, "type": "breakdown", "station": pid, "unit": u + 1, "ship": orders[i]["id"]})

            if p in block_set:
                continue   # 블록의 검사·완료는 block_work에서 했다

            # 5-3. 다 끝났으면 검사하고, 불량이면 재작업량을 넣는다. 합격하면 다음 날부터 운반을 기다린다.
            #      나눠 한 배는 부분마다 끝나지만, 검사 판정은 배 한 척에 한 번이다(같은 난수, 같은 불량률).
            #      불량이면 부분마다 자기 작업량의 비율만큼 재작업한다. 재작업비·불량 건수·검사 수도 배 한 척에 한 번.
            if cur["remaining"] <= EPS:
                work_done[p] += cur["amount"]
                group = cur["group"]
                if not cur["rework"]:
                    if group["verdict"] is None:
                        inspections[p] += 1
                        rate = station_defect_rate(st_cfg[p], crews[p], scenario, done_research, inspections[p] - 1, grades[p],
                                                   has_equipment(stations[p]))
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
                finish(i, p)
                advance(i, p, day)

        for r in schedule:
            if r["end"] == day:
                events.append({"day": day, "type": "research_done", "research": r["id"]})

        # 5-4. 블록 공정에 있는 배의 오늘 상태(4.25): 블록 하나라도 일하면 작업, 아니면 블록들 가운데 앞선 상태.
        #      블록마다 오늘 상태도 기록한다(만들기 전은 착수 전, 다음 공정 블록이 된 뒤·마친 뒤는 완료).
        if block_mode:
            best: dict[int, tuple[int, str, int, int | None]] = {}
            for b in all_blocks:
                today = block_today(b, day)
                b["daily"].append({"state": today[0], "unit": None if today[1] is None else today[1] + 1} if today
                                  else {"state": NOT_STARTED if b["state"] == "pending" else DONE, "unit": None})
                b["today"] = None
                if today is None:
                    continue
                state = STATION_WAIT if today[0] == PAIR_WAIT else today[0]
                rank = BLOCK_SHIP_RANK.index(state)
                if b["ship"] not in best or (rank, -b["p"]) < best[b["ship"]][:2]:
                    best[b["ship"]] = (rank, -b["p"], b["p"], today[1])
            for i, (rank, _, p, u) in best.items():
                if delivered[i] is None:
                    ship_state[i] = (BLOCK_SHIP_RANK[rank], p, u)

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
        # 작업장 앞 키트(4.1): T1이 실어 온 뒤 그 공정에 들어가기 전까지는 창고 밖에 쌓인 재고라 같은 재고비를 문다
        onsite = sum(bom_of(i, stations[p]["material"]) * prices[stations[p]["material"]]
                     for i, p in kit_ready if stations[p]["id"] not in spans[i])
        cost["holding"] += (value + onsite) * costs["holding_rate_per_day"]
        cost["wip"] += sum(costs["wip_per_ship_day"] for i in range(n_ships)
                           if started[i] is not None and delivered[i] is None)
        inventory_daily.append(dict(stock))
        pegging_daily.append({mid: _pegging(batches[mid]) for mid in materials})
        inventory_value_daily.append(value)
        onsite_value_daily.append(onsite)

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
            # 공정 여유(4.15): 여유 합계와 여유를 넣기 전의 납기·선가
            "buffer_days": order["buffer_days"],
            "base_due_day": order["base_due_day"],
            "base_price": order["base_price"],
            "priority": priority[i],
            "start_day": config["ships"][order["id"]]["start_day"],
            "order_days": order_days[i],
            "arrival_days": arrival_day[i],
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

    # 짝 대기(3.0): 나눠 한 배의 먼저 끝난 부분이 나머지를 기다린 날을 공정·작업장마다 센다.
    # 그 작업장은 비어 있어 다른 배를 받을 수 있으므로 OEE(작업장의 손실)에는 넣지 않고, 배의 리드타임에서는 작업으로 센다.
    pair_wait_days = [[0] * n for n in n_units]
    for i in range(n_ships):
        for rec in ship_daily[i]:
            for part in rec.get("parts", []):
                if part["state"] == PAIR_WAIT:
                    pair_wait_days[stations.index(next(s for s in stations if s["id"] == rec["station"]))][part["unit"] - 1] += 1

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
            "defect_rate": station_defect_rate(st_cfg[p], crews[p], scenario, grade=grades[p], equipment=has_equipment(st)),
            "busy_days": busy[p],
            "accident_stop_days": accident_stopped[p],
            "breakdown_stop_days": breakdown_stopped[p],
            "material_wait_days": material_wait[p],
            "labor_wait_days": labor_wait[p],
            "pair_wait_days": sum(pair_wait_days[p]),
            "breakdowns": station_breakdowns[p],
            "overtime_days": sum(overtime_days[p]),
            "work_done": work_done[p],
            "inspections": inspections[p],
            "passes": passes[p],
            "oee": {"availability": availability, "performance": performance, "quality": quality, "oee": oee},
            "units": [{"unit": u + 1, "busy_days": unit_busy[p][u], "breakdowns": unit_breakdowns[p][u],
                       "pair_wait_days": pair_wait_days[p][u],
                       "daily": station_daily[p][u]} for u in range(n_units[p])],
            # 1호 작업장의 하루 기록. 화면이 units를 읽게 되면(2.0 화면) 지운다.
            "daily": station_daily[p][0],
        })

    transporters_out = [{
        "id": TRANSPORTER_IDS[k],
        "role": "block",
        "moves": tr_moves[k],
        "breakdowns": tr_breakdowns[k],
        "daily": transporter_daily[k],
    } for k in range(n_tr)]
    forklifts_out = [{
        "id": f"F{k + 1}",
        "moves": fk_moves[k],
        "breakdowns": fk_breakdowns[k],
        "daily": forklift_daily[k],
    } for k in range(n_fk)]

    # 블록(4.25): 블록마다 작업장, 시작·끝·완료일, 하루 상태(배의 daily와 같은 길이)
    # 납기(4.25): 끝내지 못한 블록·공정은 기간 끝일로 늦은 날을 센다
    blocks_out = [{"id": b["id"], "ship": orders[b["ship"]]["id"], "station": stations[b["p"]]["id"], "no": b["no"],
                   "unit": None if b["unit"] is None else b["unit"] + 1, "start": b["start"], "end": b["end"],
                   "done_day": b["done_day"], "defect": bool(b["verdict"]),
                   "due": b["due"], "late_days": max(0, (b["done_day"] or days) - b["due"]),
                   "on_time": b["done_day"] is not None and b["done_day"] <= b["due"], "daily": b["daily"]}
                  for b in all_blocks]
    if block_mode:
        for i, sh in enumerate(ships_out):
            sh["station_dues"] = {}
            for pid, d in sdues[sh["id"]].items():
                end = spans[i][pid]["end"] if stations_ids.index(pid) in done[i] and pid in spans[i] else None
                sh["station_dues"][pid] = {"due": d, "end": end, "late_days": max(0, (end or days) - d)}

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
            # S 안전(4.14, QCDS): 잔업 사고. 등급 점수에는 넣지 않는다(D28). 잔업 일수는 사고 위험에 노출된 날(작업장 × 일)
            "safety": {"accidents": accidents, "stop_days": sum(accident_stopped),
                       "overtime_days": sum(sum(u) for u in overtime_days), "accident_cost": cost["accident"]},
        },
        "status": {"delivered": n_delivered, "in_progress": n_in_progress,
                   "not_started": n_ships - n_delivered - n_in_progress,
                   "defects": defects, "accidents": accidents,
                   "breakdowns": sum(station_breakdowns) + sum(tr_breakdowns) + sum(fk_breakdowns)},
        "costs": cost,
        "total_cost": total_cost,
        "revenue": revenue,
        "profit": round(revenue - total_cost, 2),
        "workforce": {"pool": pool, "pools": pools, "man_days": man_days, "idle_man_days": pool * days - man_days,
                      "utilization": man_days / (pool * days), "daily": workforce_daily},
        "ships": ships_out,
        "stations": stations_out,
        "transporters": transporters_out,
        "forklifts": forklifts_out,
        **({"blocks": blocks_out,
            "block_due": {"blocks": len(blocks_out), "on_time": sum(b["on_time"] for b in blocks_out),
                          "rate": sum(b["on_time"] for b in blocks_out) / len(blocks_out) if blocks_out else None,
                          "late_days": sum(b["late_days"] for b in blocks_out)}} if block_mode else {}),
        "research": schedule,
        "safety_stock": safety,
        "inventory_daily": inventory_daily,
        "pegging_daily": pegging_daily,
        "inventory_value_daily": inventory_value_daily,
        "onsite_value_daily": onsite_value_daily,
        "events": events,
        "findings": _findings(ships_out),
        "end_state": {
            "research_done": [r["id"] for r in schedule if r["done"]],
            "stock": dict(stock),
            "in_progress": [{"ship": orders[i]["id"],
                             "station": (stations[groups[i]["station"]]["id"] if i in groups
                                         else (stations[candidates(i)[0]]["id"] if candidates(i) else None))}
                            for i in range(n_ships) if started[i] is not None and delivered[i] is None],
        },
    }


def _worst(totals: dict[str, int], order: list[str]) -> tuple[str, int] | None:
    """값이 가장 큰 항목. 같으면 order(공정·배 목록)의 앞. 0뿐이면 없다."""
    best = None
    for key in order:
        if totals.get(key, 0) > 0 and (best is None or totals[key] > best[1]):
            best = (key, totals[key])
    return best


def _management(result: dict[str, Any], config: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """평가서 부록의 7관리 지표(4.15, D61): 계획·일정·자재·설비·품질·안전마다 대표 지표와 개선 포인트.

    데이터 관리는 평가서 전체가 그 일이라 재지 않는다. 등급 점수에는 넣지 않는다. 포인트는 손실이 있는 요소에만,
    {"code", 어디(station·ship), 크기}로 준다. 문구는 화면이 code마다 정한 안내를 쓴다(의문점 카드와 같은 방식).
    """
    days = result["days"]
    ships = result["ships"]
    station_ids = [st["id"] for st in scenario["stations"] if not is_skipped(st)]
    ship_ids = [sh["id"] for sh in ships]
    by_id = {st["id"]: st for st in result["stations"]}

    def loss_by_station(kind: str) -> dict[str, int]:
        totals: dict[str, int] = {}
        for f in result["findings"]:
            if f["kind"] == kind:
                totals[f["station"]] = totals.get(f["station"], 0) + f["days"]
        return totals

    def part_sum(state: str) -> int:
        return sum(sh["lead_time_parts"].get(state, 0) for sh in ships)

    # 계획: 계획 간트(배가 혼자 쓴다고 본 일정)의 끝날과 실제 인도일
    plan = plan_schedule(config, scenario)
    slips: dict[str, int] = {}
    on_plan = 0
    for sh in ships:
        planned_end = max(span["end"] + span.get("buffer", 0) for span in plan["ships"][sh["id"]].values())
        end = sh["delivered_day"] if sh["delivered_day"] is not None else days
        slips[sh["id"]] = max(0, end - planned_end)
        if sh["delivered_day"] is not None and sh["delivered_day"] <= planned_end:
            on_plan += 1
    conflict_days = sum(c["end"] - c["start"] + 1 for c in plan["conflicts"])
    worst_slip = _worst(slips, ship_ids)
    plan_point = ({"code": "conflict", "days": conflict_days} if conflict_days
                  else {"code": "slip", "ship": worst_slip[0], "days": worst_slip[1]} if worst_slip else None)

    # 일정: 리드타임 중 일한 날(작업·운반)의 비율과 기다린 날
    lead = sum(sh["lead_time"] for sh in ships)
    flowing = part_sum(WORK) + part_sum(TRANSPORT)
    waits = {k: part_sum(k) for k in (STATION_WAIT, LABOR_WAIT, TRANSPORT_WAIT)}
    worst_wait = _worst(waits, list(waits))
    schedule_point = None
    if worst_wait:
        where = _worst(loss_by_station(worst_wait[0]), station_ids)
        schedule_point = {"code": worst_wait[0], "station": where[0] if where else None, "days": worst_wait[1]}

    # 자재: 자재 대기와 재고
    material_wait = part_sum(MATERIAL_WAIT)
    inv = result["inventory_value_daily"]
    material_point = None
    if material_wait:
        where = _worst(loss_by_station(MATERIAL_WAIT), station_ids)
        material_point = {"code": "material_wait", "station": where[0] if where else None, "days": material_wait}
    elif config.get("ordering") == "bulk" and result["costs"]["holding"] > 0:
        material_point = {"code": "holding", "cost": result["costs"]["holding"]}

    # 설비: 설비가 있는 공정(시운전 제외)의 OEE 평균과 고장
    equipped = [by_id[st["id"]] for st in scenario["stations"]
                if not is_skipped(st) and has_equipment(st) and by_id[st["id"]]["oee"]["oee"] is not None]
    oee = sum(st["oee"]["oee"] for st in equipped) / len(equipped) if equipped else None
    stops = {sid: by_id[sid]["breakdown_stop_days"] for sid in station_ids}
    worst_stop = _worst(stops, station_ids)
    equipment_point = {"code": "breakdown", "station": worst_stop[0], "days": worst_stop[1]} if worst_stop else None

    # 품질: 직행률과 불량
    defects: dict[str, int] = {}
    accidents: dict[str, int] = {}
    for ev in result["events"]:
        if ev["type"] == "defect":
            defects[ev["station"]] = defects.get(ev["station"], 0) + 1
        elif ev["type"] == "accident":
            accidents[ev["station"]] = accidents.get(ev["station"], 0) + 1
    worst_defect = _worst(defects, station_ids)
    quality_point = {"code": "defect", "station": worst_defect[0], "count": worst_defect[1]} if worst_defect else None

    # 안전: 잔업 사고. 사고가 없어도 잔업한 날은 위험에 노출된 날
    safety = result["qcd"]["safety"]
    worst_accident = _worst(accidents, station_ids)
    worst_overtime = _worst({sid: by_id[sid]["overtime_days"] for sid in station_ids}, station_ids)
    safety_point = ({"code": "accident", "station": worst_accident[0], "count": worst_accident[1]} if worst_accident
                    else {"code": "overtime", "station": worst_overtime[0], "days": worst_overtime[1]} if worst_overtime else None)

    return {
        "plan": {"on_plan": on_plan, "ships": len(ships), "slip_days": sum(slips.values()),
                 "conflict_days": conflict_days, "point": plan_point},
        "schedule": {"flow_efficiency": flowing / lead if lead else None, "lead_days": lead,
                     "wait_days": waits, "point": schedule_point,
                     **({"block_due": result["block_due"]} if "block_due" in result else {})},
        "material": {"wait_days": material_wait,
                     "supply_delays": sum(1 for ev in result["events"] if ev["type"] == "supply_delay"),
                     "avg_inventory": round(sum(inv) / len(inv), 2) if inv else 0.0,
                     "holding": result["costs"]["holding"], "point": material_point},
        "equipment": {"oee": oee, "breakdowns": result["status"]["breakdowns"],
                      "stop_days": sum(stops.values()), "point": equipment_point},
        "quality": {"first_pass_yield": result["qcd"]["quality"]["first_pass_yield"],
                    "defects": result["status"]["defects"], "rework_days": part_sum(REWORK), "point": quality_point},
        "safety": {"accidents": safety["accidents"], "stop_days": safety["stop_days"],
                   "overtime_days": safety["overtime_days"], "point": safety_point},
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
    # 공정 여유(4.15)로 늦춘 납기가 아니라 원래 납기로 가른다(납기를 기간 밖으로 밀어 대상에서 빼지 못하게)
    targets = [s for s in result["ships"] if 1 <= s["order_day"] <= days and s.get("base_due_day", s["due_day"]) <= days]
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

    # 선배의 팁(4.23): S까지 모자란 점수와 먼저 볼 항목. 목표(가중치 점수)에 가장 많이 못 미친 항목이고,
    # 모두 목표를 채웠으면 상한(1.3배)까지 남은 이익. 그것도 다 채웠으면 None
    short = max(parts, key=lambda p: w[p["key"]] - p["points"])
    profit_part = parts[1]
    focus = (short["key"] if w[short["key"]] - short["points"] >= 0.05
             else "profit" if profit_part["max"] - profit_part["points"] >= 0.05 else None)
    to_s = {"need": round(max(g["bands"]["S"] - score, 0), 1), "focus": focus}
    out: dict[str, Any] = {"score": score, "grade": _band(score, g["bands"]), "parts": parts,
                           "to_s": to_s, "baseline": None, "vs_baseline": None}
    if base is not None and base_cfg is not None:
        # base는 기준선 요약(_baseline_summary): 점수·등급·이익·납기 준수 척수
        preset = next(p for p in load_presets(scenario.get("id", DEFAULT_SCENARIO)) if p["id"] == g["baseline_preset"])
        out["baseline"] = {"preset": preset["id"], "name": preset["name"], "score": base["score"],
                           "grade": base["grade"], "profit": base["profit"], "pool": base_cfg["pool"],
                           "on_time": base["on_time"]}
        out["vs_baseline"] = {"profit": round(profit - base["profit"], 2),
                              "pool": config["pool"] - base_cfg["pool"],
                              "score": round(score - base["score"], 1)}
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
    config = complete_config(config, scenario)
    validate_config(config, scenario)
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    return {sid: {mid: _clamp_day(need - lead[mid] - buffer_days, scenario) for mid, need in needs.items()}
            for sid, needs in _need_days(config, scenario).items()}


def _take_pegged(batches: list[list[Any]], ship: str, need: int) -> list[dict[str, Any]]:
    """출고할 자재를 어느 몫에서 꺼냈는지 정한다(자재 페깅, 3.1, 기록만).

    자기 몫 먼저, 다음 공용(처음 재고), 그래도 모자라면 남의 몫을 먼저 들어온 것부터 빌린다.
    같은 순서 안에서는 먼저 들어온 묶음부터. 꺼낸 몫을 [{"ship": 몫, "quantity": 수량}]으로 돌려준다.
    """
    rank = lambda b: (0 if b[1] == ship else 1 if b[1] is None else 2, b[0])
    taken: dict[str | None, int] = {}
    for b in sorted(batches, key=rank):
        if need <= 0:
            break
        q = min(b[2], need)
        b[2] -= q
        need -= q
        taken[b[1]] = taken.get(b[1], 0) + q
    batches[:] = [b for b in batches if b[2] > 0]
    return [{"ship": owner, "quantity": q} for owner, q in taken.items()]


def _pegging(batches: list[list[Any]]) -> list[dict[str, Any]]:
    """창고 재고를 몫별로 묶는다. 먼저 들어온 몫이 앞이다. 몫이 None이면 공용."""
    out: dict[str | None, int] = {}
    for _, owner, q in sorted(batches, key=lambda b: b[0]):
        out[owner] = out.get(owner, 0) + q
    return [{"ship": owner, "quantity": q} for owner, q in out.items()]


def resolve_order_days(config: dict[str, Any], scenario: dict[str, Any] | None = None) -> dict[str, dict[str, int | None]]:
    """발주 방식(ordering)에 따른 배별 발주일. 방식이 없으면 설정의 order_days를 그대로 쓴다.

    bulk: 모든 자재를 1일에. jit: 필요일 − 리드타임 − 여유일. late: 필요일에 (리드타임만큼 자재 대기).
    필요일은 자재가 항상 충분하다고 보고 한 번 돌려서 구한다. 실제 실행에서는 앞 공정이 늦어지면 필요일도 밀린다.
    """
    config = normalize_config(config)
    scenario = scenario or scenario_of(config)
    config = complete_config(config, scenario)
    ordering = config.get("ordering")
    if ordering is None:
        return {sid: dict(ship.get("order_days") or {}) for sid, ship in config["ships"].items()}
    lead = {m["id"]: m["lead_days"] for m in scenario["materials"]}
    if ordering == "bulk":
        return {sid: {mid: 1 for mid in lead} for sid in config["ships"]}
    buffer = jit_buffer(config, scenario)
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

    # 필요일 = 그 자재를 출고한 날(4.0: T1이 키트를 실은 날). 쓰지 못했으면 마지막 날.
    issued: dict[tuple[str, str], int] = {}
    for ev in result["events"]:
        if ev["type"] == "issue":
            issued.setdefault((ev["ship"], ev["material"]), ev["day"])
    # 그 배가 쓰지 않는 자재(LNG선만 쓰는 보냉재, 4.14)는 발주하지 않는다
    station_material = {s["id"]: s["material"] for s in scenario["stations"] if s["material"]}
    return {ship["id"]: {mid: issued.get((ship["id"], mid), scenario["days"]) for mid in station_material.values()
                         if scenario["ship_types"][ship["type"]]["bom"].get(mid, 0) > 0}
            for ship in result["ships"]}


def _clamp_day(day: int, scenario: dict[str, Any]) -> int:
    return min(scenario["days"], max(1, day))
