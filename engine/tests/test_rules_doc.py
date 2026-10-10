"""규칙 문서 10장 "검증용 예시"의 값을 그대로 확인한다.

    python -m unittest discover -s engine/tests -t engine     (또는 pytest engine)

여기서 하나라도 깨지면 엔진이 규칙 문서와 달라진 것이다.
"""

import copy
import unittest

from shipyard import ConfigError, list_scenarios, load_presets, load_scenario, preview, simulate, suggest_order_days
from shipyard.sim import _take_pegged, resolve_order_days

PRESETS = {p["id"]: p["config"] for p in load_presets()}
# 공정 10개(4.0, D41): 절단 → 가공 → 소조립 → 중조립 → (도장 ∥ 선행의장) → PE장 → 탑재 → 안벽의장 → 시운전
STATIONS = ["cutting", "processing", "sub_assembly", "block_assembly", "painting", "pre_outfitting", "grand_assembly", "erection", "quay_outfitting", "sea_trial"]
STATES = ["work", "rework", "material_wait", "station_wait", "labor_wait",
          "transport", "transport_wait", "accident_stop", "breakdown_stop"]


def opened(scenario_id="basic"):
    """분기의 옵션 잠금(D33)을 푼 시나리오. 규칙이 어떻게 계산되는지 보는 테스트는 잠긴 옵션도 돌려 본다."""
    sc = load_scenario(scenario_id)
    sc.pop("options", None)
    return sc


def open_sim(cfg, **kw):
    """옵션 잠금을 푼 같은 분기로 실행한다(화면에서는 막힌 옵션의 계산 검증용)."""
    return simulate(cfg, opened(cfg.get("scenario", "basic")), **kw)


def open_preview(cfg):
    return preview(cfg, opened(cfg.get("scenario", "basic")))


def one_ship_scenario(stock, quality=0.99):
    """손 계산 예시용: S1 한 척, 초기 재고 지정, 불량 없음(난수 0.99). 옵션 잠금은 없다."""
    sc = opened()
    # 납기 39일(4.0): 공정 10개로 막힘 없이 35일에 인도되므로, 기본 예시가 지연으로 시작하지 않게 기본 분기 S1(30일)보다 늦춘다
    sc["orders"] = [{**o, "due_day": 39} for o in sc["orders"] if o["id"] == "S1"]
    sc["initial_stock"] = stock
    sc["random"]["quality"] = {"S1": {s["id"]: quality for s in sc["stations"]}}
    return sc


def one_ship_config(order_days=None):
    """2명, 트랜스포터 1대(정비), 지게차 1대(정비, 4.3), 전 공정 표준·정비. 로트를 다 나르는 데 이틀 걸린다."""
    def station():
        return {"method": "standard", "overtime": False, "maintenance": True}
    return {
        "ships": {"S1": {"priority": 1, "start_day": 1, "order_days": order_days or {}}},
        "stations": {pid: station() for pid in STATIONS},
        "pool": 2,
        "transporters": {"count": 1, "maintenance": True},
        "forklifts": {"count": 1, "maintenance": True},
        "research": [],
        "skilled_station": None,
    }


def spans(result, ship_id):
    ship = next(s for s in result["ships"] if s["id"] == ship_id)
    return {k: (v["start"], v["end"]) for k, v in ship["spans"].items()}


def segments(ship, station=None):
    return [(s["state"], s["start"], s["end"]) for s in ship["segments"] if station in (None, s["station"])]


FULL = {"paper": 8, "paint": 4, "flag": 2}


class HandExamples(unittest.TestCase):
    # 4.0 공정 그래프(D41): 절단 → 가공 → 소조립 → 중조립 → (도장 ∥ 선행의장) → PE장 → 탑재 → 안벽의장 → 시운전.
    # 손 계산 예시의 배는 VLCC(작업량 절단 3, 가공 4, 소 8, 중 16, 도장 4, 선행의장 4, PE 8, 탑재 14, 안벽의장 4, 시운전 3), 납기 39일.
    # 4.2: 탑재 8 → 14(도크가 조선소의 병목), 종이(철판)는 강재 적치장에서 롤러 컨베이어로 절단에 들어가는 날 바로 출고.
    # 직종 인원은 조립 2(설정의 pool), 가공·탑재·도장·의장 기본 2씩. 시운전은 외부팀이다.

    def test_example_1_schedule(self):
        r = simulate(one_ship_config(), one_ship_scenario(FULL))
        # 처리량 2/일. 블록 운반(T2)은 끝난 다음 날부터 6씩 이틀, 다 나른 둘째 날 바로 다음 공정에 들어간다(소→중, 중→도장, 선행의장→PE장).
        # 절단 → 가공은 같은 가공 공장, 도장 ↔ 선행의장은 같은 블록 마감동이라 다음 날, 가공 → 소조립은 컨베이어벨트로 다음 날,
        # PE장 → 탑재는 크레인, 탑재 → 안벽의장 → 시운전은 예인으로 다음 날. 절단 3은 2일(올림), 가공 4는 2일.
        # 중조립을 마친 배는 도장과 선행의장 둘 다 할 수 있고, 둘 다 비어 있으면 목록 순서(도장 먼저)다. 같은 배는 하루에 한 공정.
        self.assertEqual(spans(r, "S1"), {"cutting": (1, 2), "processing": (3, 4), "sub_assembly": (5, 8),
                                          "block_assembly": (10, 17), "painting": (19, 20),
                                          "pre_outfitting": (21, 22), "grand_assembly": (24, 27), "erection": (28, 34),
                                          "quay_outfitting": (35, 36), "sea_trial": (37, 38)})
        self.assertEqual(segments(r["ships"][0]), [
            ("work", 1, 2), ("work", 3, 4), ("work", 5, 8), ("transport", 9, 9), ("work", 10, 17), ("transport", 18, 18),
            ("work", 19, 20), ("work", 21, 22), ("transport", 23, 23), ("work", 24, 27), ("work", 28, 34), ("work", 35, 36),
            ("work", 37, 38)])
        self.assertEqual((r["ships"][0]["delivered_day"], r["ships"][0]["late_days"]), (38, 0))
        self.assertEqual(r["costs"]["wip"], 370)
        # 재고비(4.1): 창고 72(초기 재고) + 작업장 앞 키트. 물감 키트는 11~18일(8일) × 160 × 1% = 12.8,
        # 깃발 키트는 29~34일(6일) × 200 × 1% = 12. 종이는 키트가 아니라 절단에 들어가는 날 컨베이어로 출고된다.
        self.assertAlmostEqual(r["costs"]["holding"], 72 + 12.8 + 12)
        # 종이(강재 적치장, 4.2)는 절단에 들어가는 1일에 롤러 컨베이어로 출고(트랜스포터 없음). 물류창고 자재는 지게차(F1) 키트(4.3):
        # 물감(도장)은 중조립에 들어간 10일 요청 → 11일, 깃발(안벽의장)은 탑재에 들어간 28일 요청 → 29일에 실어 작업장에 놓는다.
        self.assertEqual([(e["day"], e["material"], e["station"], e.get("forklift")) for e in r["events"] if e["type"] == "issue"],
                         [(1, "paper", "cutting", None), (11, "paint", "painting", "F1"), (29, "flag", "quay_outfitting", "F1")])
        # 가공 → 소조립 부재 팔레트도 지게차 일감이다(4.3): 가공을 끝낸 4일의 다음 날(5일) F1이 싣고, 그날 소조립에 들어간다.
        self.assertEqual([(d, j["kind"], j["ship"]) for d, rec in enumerate(r["forklifts"][0]["daily"], start=1) for j in rec["jobs"]],
                         [(5, "pallet", "S1"), (11, "kit", "S1"), (29, "kit", "S1")])
        # 중조립은 17일에 일한 날이 8일째라 고장 판정: 난수 0.05 < 정비 기준 0.1 → 고장. 배는 이미 끝나 손실은 없다.
        self.assertEqual([(e["day"], e["station"]) for e in r["events"] if e["type"] == "breakdown"],
                         [(17, "block_assembly")])
        self.assertEqual(r["costs"]["breakdown"], 150)
        # 운반 설비 = 트랜스포터(블록) 1대 + 지게차 1대(4.3, D46): 2대 × (5 × 120일 + 정비 50) = 1,300.
        self.assertEqual(r["costs"]["transporter"], 1300)
        # 인건비 = 직종 인원 10명 × 10 × 120일 + 시운전 외부팀 2일 × 20 = 12,040(4.0, D42·D44)
        self.assertEqual(r["costs"]["labor"], 12040)

    def test_example_4_split(self):
        # 3.0 손 계산 예시 4: 예시 1에서 중조립만 작업장 2곳 + 나눠 하기, 조립 인원 4명.
        cfg = one_ship_config()
        cfg["pool"] = 4
        cfg["stations"]["block_assembly"].update({"units": 2, "split": True})
        r = simulate(cfg, one_ship_scenario(FULL))
        # 중조립 16을 2곳에 8씩, 곳마다 2명 → 4일(10~13일). 뒤 공정이 모두 4일 당겨져 인도는 예시 1(38일)보다 4일 빠른 34일.
        self.assertEqual(spans(r, "S1"), {"cutting": (1, 2), "processing": (3, 4), "sub_assembly": (5, 8),
                                          "block_assembly": (10, 13), "painting": (15, 16),
                                          "pre_outfitting": (17, 18), "grand_assembly": (20, 23), "erection": (24, 30),
                                          "quay_outfitting": (31, 32), "sea_trial": (33, 34)})
        self.assertEqual(r["ships"][0]["delivered_day"], 34)
        # 재공비 33일 × 10, 인건비 (조립 4 + 가공·탑재·도장·의장 2씩) × 10 × 120일 + 시운전 40, 증설비 300, 정비비 작업장 11곳 × 100
        self.assertEqual((r["costs"]["wip"], r["costs"]["labor"], r["costs"]["investment"], r["costs"]["maintenance"]),
                         (330, 14440, 300, 1100))
        # 조립 인원이 2명이면 2호는 1호가 끝날 때까지 인력 대기, 그 뒤 1호가 짝 대기 → 나누지 않은 것과 같은 10~17일.
        cfg["pool"] = 2
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual(spans(r, "S1")["block_assembly"], (10, 17))
        parts = [[p["state"] for p in d["parts"]] for d in r["ships"][0]["daily"][9:17]]
        self.assertEqual(parts, [["work", "labor_wait"]] * 4 + [["pair_wait", "work"]] * 4)
        # 공정 결과의 짝 대기 일수: 1호가 4일 기다렸다(OEE에는 넣지 않는다).
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual((block["pair_wait_days"], [u["pair_wait_days"] for u in block["units"]]), (4, [4, 0]))
        # 3곳 + 6명이면 부분 5.33, 3일(10~12일), 인도 33일.
        cfg["pool"] = 6
        cfg["stations"]["block_assembly"]["units"] = 3
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual((spans(r, "S1")["block_assembly"], r["ships"][0]["delivered_day"]), ((10, 12), 33))

    def test_example_2_defect_and_rework(self):
        cfg = one_ship_config()
        cfg["stations"]["block_assembly"] = {"method": "fast", "overtime": True, "maintenance": False}
        sc = one_ship_scenario(FULL)
        sc["random"]["quality"]["S1"]["block_assembly"] = 0.21
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        r = simulate(cfg, sc)
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual(block["defect_rate"], 0.5)
        self.assertEqual(block["max_rate"], 3.75)
        self.assertEqual(segments(r["ships"][0], "block_assembly"),
                         [("work", 10, 14), ("rework", 15, 17), ("transport", 18, 18)])
        # 중조립이 17일에 끝나 예시 1과 같다(속도로 번 3일을 재작업으로 다시 썼다).
        self.assertEqual(r["ships"][0]["delivered_day"], 38)
        self.assertEqual(r["costs"]["rework"], 200)
        self.assertEqual(r["costs"]["overtime"], 80)
        self.assertEqual(r["costs"]["maintenance"], base["costs"]["maintenance"] - 100)
        self.assertEqual(r["total_cost"] - base["total_cost"], 180)

    def test_example_3_late_order(self):
        r = simulate(one_ship_config({"flag": 28}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        ship = r["ships"][0]
        # 깃발은 안벽의장(4.0)에서 쓴다. 탑재를 34일에 끝내 35일부터 안벽의장에 들어갈 수 있지만, 28일에 발주한 깃발이
        # 38일에 들어와 지게차가 그날 실어 온다. 35~37일 3일 자재 대기, 안벽의장 38~39일, 시운전 40~41일.
        self.assertEqual(spans(r, "S1")["quay_outfitting"], (38, 39))
        self.assertEqual(ship["lead_time_parts"]["material_wait"], 3)
        self.assertEqual((ship["delivered_day"], ship["late_days"]), (41, 2))
        # 지연 배상 6,000(VLCC 선가, 4.0에 2배) × 3% × 2일 = 360, 재공비는 3일 × 10 = 30 늘어 370 → 400
        self.assertEqual(r["costs"]["late_penalty"], 360)
        self.assertEqual(r["costs"]["wip"], 400)

    def test_example_3_early_order(self):
        with_flag = simulate(one_ship_config({"flag": 1}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        self.assertEqual(with_flag["ships"][0]["delivered_day"], 38)
        # 깃발 키트는 29일에 실려 나간다(출고). 깃발 200어치를 11~28일 18일 보관.
        # 기준 실행은 깃발을 1~28일 28일 동안 들고 있으므로 차이는 10일분 200 × 1% × 10 = 20이다.
        self.assertAlmostEqual(base["costs"]["holding"] - with_flag["costs"]["holding"], 20)


class Presets(unittest.TestCase):
    """10장의 프리셋 3개 기대 결과."""

    # 4.0 물류 전담(D39) 뒤의 값. 등급 구간은 버전을 올릴 때 조율한다(D40): "4.3.0 조율 값".
    EXPECTED = {
        "unmanaged": {
            "delivered": [82, 74, 66, 59, 51, 36], "late": [40, 18, 0, 0, 0, 0], "fpy": (32, 60), "on_time": 4,
            "accidents": 7, "breakdowns": 13, "man_days": 334,
            "costs": {'labor': 28980.0, 'overtime': 1670.0, 'maintenance': 0, 'material': 3060.0, 'holding': 42.4, 'wip': 3290.0, 'rework': 5600.0, 'accident': 2100.0, 'breakdown': 1950.0, 'transporter': 1800, 'investment': 0.0, 'research': 0, 'late_penalty': 10008.0},
            "total": 58500.4, "profit": -24900.4,
            "spans": {'S1': [(10, 10), (18, 19), (23, 27), (42, 51), (54, 55), (56, 58), (60, 64), (70, 76), (79, 81), (82, 82)], 'S2': [(9, 9), (13, 14), (20, 22), (38, 41), (45, 45), (48, 50), (52, 54), (62, 69), (71, 73), (74, 74)], 'S3': [(7, 8), (10, 12), (13, 19), (33, 37), (39, 40), (43, 47), (49, 51), (54, 61), (63, 64), (65, 66)], 'S4': [(6, 6), (8, 9), (11, 12), (27, 32), (36, 37), (38, 42), (44, 45), (46, 53), (55, 57), (58, 59)], 'S5': [(4, 5), (6, 7), (8, 10), (14, 26), (28, 29), (30, 32), (34, 38), (39, 42), (48, 49), (50, 51)], 'S6': [(3, 3), (4, 4), (5, 6), (8, 13), (17, 18), (19, 21), (23, 24), (25, 29), (34, 35), (36, 36)]},
            "parts": {'S1': [25, 4, 4, 31, 0, 3, 2, 9, 4], 'S2': [21, 8, 3, 32, 0, 3, 3, 1, 3], 'S3': [25, 7, 3, 18, 0, 3, 0, 5, 5], 'S4': [21, 7, 3, 11, 0, 3, 6, 6, 2], 'S5': [25, 8, 7, 3, 0, 3, 0, 3, 2], 'S6': [21, 4, 6, 0, 0, 3, 2, 0, 0]},
            "oee": {'cutting': (66.7, 60.0, 66.7, 26.7), 'processing': (80.0, 57.8, 50.0, 23.1), 'sub_assembly': (80.0, 70.7, 50.0, 28.3), 'block_assembly': (77.3, 81.6, 50.0, 31.5), 'painting': (100.0, 58.2, 66.7, 38.8), 'pre_outfitting': (77.3, 53.3, 16.7, 6.9), 'grand_assembly': (90.0, 62.2, 66.7, 37.3), 'erection': (80.0, 87.5, 66.7, 46.7), 'quay_outfitting': (51.7, 53.3, 50.0, 13.8), 'sea_trial': (100.0, 66.7, 50.0, 33.3)},
        },
        "managed": {
            "delivered": [42, 51, 70, 80, 95, 106], "late": [0, 0, 0, 0, 0, 0], "fpy": (59, 60), "on_time": 6,
            "accidents": 0, "breakdowns": 4, "man_days": 373,
            "costs": {'labor': 13890.0, 'overtime': 0.0, 'maintenance': 1000, 'material': 3060.0, 'holding': 171.4, 'wip': 2430.0, 'rework': 200.0, 'accident': 0.0, 'breakdown': 600.0, 'transporter': 1950, 'investment': 0.0, 'research': 0, 'late_penalty': 0.0},
            "total": 23301.4, "profit": 10298.6,
            "spans": {'S1': [(3, 4), (5, 6), (7, 12), (14, 21), (23, 24), (25, 26), (28, 31), (32, 38), (39, 40), (41, 42)], 'S2': [(12, 12), (13, 14), (15, 20), (24, 31), (33, 34), (35, 36), (38, 39), (40, 47), (48, 49), (50, 51)], 'S3': [(24, 25), (26, 27), (28, 35), (39, 47), (49, 50), (51, 52), (54, 57), (58, 66), (67, 68), (69, 70)], 'S4': [(40, 40), (41, 42), (43, 48), (51, 60), (62, 63), (64, 65), (67, 68), (69, 76), (77, 78), (79, 80)], 'S5': [(52, 53), (54, 55), (56, 62), (64, 72), (74, 75), (76, 79), (81, 84), (85, 91), (92, 93), (94, 95)], 'S6': [(70, 70), (71, 72), (73, 75), (77, 84), (86, 87), (88, 89), (91, 92), (93, 102), (103, 104), (105, 106)]},
            "parts": {'S1': [35, 2, 0, 0, 0, 3, 0, 0, 0], 'S2': [35, 0, 0, 0, 0, 3, 2, 0, 0], 'S3': [36, 0, 0, 0, 4, 3, 2, 0, 2], 'S4': [35, 0, 0, 0, 0, 3, 1, 0, 2], 'S5': [37, 0, 0, 0, 4, 3, 0, 0, 0], 'S6': [32, 0, 0, 0, 0, 3, 0, 0, 2]},
            "oee": {'cutting': (100.0, 44.4, 100.0, 44.4), 'processing': (100.0, 46.7, 100.0, 46.7), 'sub_assembly': (83.3, 40.9, 83.3, 28.4), 'block_assembly': (92.6, 44.8, 100.0, 41.5), 'painting': (100.0, 46.7, 100.0, 46.7), 'pre_outfitting': (85.7, 53.3, 100.0, 45.7), 'grand_assembly': (100.0, 53.3, 100.0, 53.3), 'erection': (91.8, 53.3, 100.0, 49.0), 'quay_outfitting': (100.0, 53.3, 100.0, 53.3), 'sea_trial': (100.0, 40.0, 100.0, 40.0)},
        },
        "all_in": {
            "delivered": [34, 47, 56, 60, 64, 73], "late": [0, 0, 0, 0, 0, 0], "fpy": (42, 60), "on_time": 6,
            "accidents": 7, "breakdowns": 3, "man_days": 314,
            "costs": {'labor': 43660.0, 'overtime': 1570.0, 'maintenance': 1000, 'material': 3060.0, 'holding': 881.0, 'wip': 3000.0, 'rework': 3600.0, 'accident': 2100.0, 'breakdown': 450.0, 'transporter': 1950, 'investment': 0.0, 'research': 0, 'late_penalty': 0.0},
            "total": 61271.0, "profit": -27671.0,
            "spans": {'S1': [(3, 3), (4, 5), (6, 10), (12, 16), (18, 19), (20, 22), (24, 26), (27, 30), (31, 33), (34, 34)], 'S2': [(4, 4), (6, 6), (11, 13), (17, 22), (26, 26), (27, 29), (31, 33), (34, 44), (45, 46), (47, 47)], 'S3': [(5, 5), (7, 8), (14, 18), (23, 30), (33, 34), (35, 36), (38, 40), (45, 52), (53, 54), (55, 56)], 'S4': [(6, 6), (9, 10), (19, 20), (31, 36), (40, 41), (42, 43), (45, 46), (53, 57), (58, 59), (60, 60)], 'S5': [(7, 8), (11, 12), (21, 23), (37, 44), (47, 48), (49, 51), (53, 55), (58, 61), (62, 63), (64, 64)], 'S6': [(9, 9), (13, 13), (24, 25), (45, 51), (55, 56), (57, 59), (61, 62), (63, 70), (71, 72), (73, 73)]},
            "parts": {'S1': [25, 4, 2, 0, 0, 3, 0, 0, 0], 'S2': [21, 6, 2, 8, 0, 3, 2, 3, 2], 'S3': [25, 5, 2, 11, 0, 3, 1, 5, 4], 'S4': [21, 4, 2, 23, 0, 3, 2, 3, 2], 'S5': [25, 5, 2, 25, 0, 3, 4, 0, 0], 'S6': [21, 2, 2, 30, 0, 3, 9, 6, 0]},
            "oee": {'cutting': (77.8, 62.9, 83.3, 40.7), 'processing': (76.9, 60.0, 83.3, 38.5), 'sub_assembly': (87.0, 70.7, 50.0, 30.7), 'block_assembly': (76.2, 81.7, 66.7, 41.5), 'painting': (100.0, 58.2, 66.7, 38.8), 'pre_outfitting': (84.2, 53.3, 33.3, 15.0), 'grand_assembly': (100.0, 63.3, 83.3, 52.8), 'erection': (80.0, 87.5, 66.7, 46.7), 'quay_outfitting': (100.0, 53.3, 83.3, 44.4), 'sea_trial': (100.0, 74.3, 83.3, 61.9)},
        },
    }

    def check(self, preset_id):
        exp = self.EXPECTED[preset_id]
        r = simulate(PRESETS[preset_id])
        self.assertEqual([s["delivered_day"] for s in r["ships"]], exp["delivered"])
        self.assertEqual([s["late_days"] for s in r["ships"]], exp["late"])
        q = r["qcd"]["quality"]
        self.assertEqual((q["passes"], q["inspections"]), exp["fpy"])
        self.assertEqual(r["qcd"]["delivery"]["on_time"], exp["on_time"])
        self.assertEqual(r["status"]["accidents"], exp["accidents"])
        self.assertEqual(r["status"]["breakdowns"], exp["breakdowns"])
        self.assertEqual(r["workforce"]["man_days"], exp["man_days"])
        for key, value in exp["costs"].items():
            self.assertAlmostEqual(r["costs"][key], value, places=2, msg=key)
        self.assertAlmostEqual(r["total_cost"], exp["total"], places=2)
        self.assertAlmostEqual(r["profit"], exp["profit"], places=2)
        for ship in r["ships"]:
            got = [((ship["spans"][p]["start"], ship["spans"][p]["end"]) if p in ship["spans"] else None) for p in STATIONS]
            self.assertEqual(got, exp["spans"][ship["id"]], ship["id"])
            self.assertEqual([ship["lead_time_parts"][s] for s in STATES], exp["parts"][ship["id"]], ship["id"])
            self.assertEqual(ship["lead_time"], sum(exp["parts"][ship["id"]]))
        for st in r["stations"]:
            o = st["oee"]
            got = tuple(round(o[k] * 100, 1) for k in ("availability", "performance", "quality", "oee"))
            self.assertEqual(got, exp["oee"][st["id"]], st["id"])

    def test_unmanaged(self):
        self.check("unmanaged")

    def test_managed(self):
        self.check("managed")

    def test_all_in(self):
        self.check("all_in")

    def test_accident_and_breakdown_days(self):
        def stops(pid):
            return [(e["day"], e["type"], e.get("station") or e.get("transporter") or e.get("forklift"))
                    for e in simulate(PRESETS[pid])["events"] if e["type"] in ("accident", "breakdown")]
        self.assertEqual(stops("unmanaged"), [(10, 'breakdown', 'cutting'), (13, 'breakdown', 'sub_assembly'), (14, 'breakdown', 'TR'), (14, 'accident', 'processing'), (15, 'breakdown', 'F1'), (15, 'breakdown', 'block_assembly'), (19, 'accident', 'block_assembly'), (27, 'accident', 'sub_assembly'), (30, 'breakdown', 'TR'), (39, 'breakdown', 'TR'), (39, 'breakdown', 'pre_outfitting'), (42, 'accident', 'block_assembly'), (43, 'accident', 'pre_outfitting'), (46, 'accident', 'erection'), (47, 'breakdown', 'block_assembly'), (55, 'breakdown', 'erection'), (60, 'breakdown', 'TR'), (60, 'breakdown', 'grand_assembly'), (71, 'accident', 'erection'), (79, 'breakdown', 'F1')])
        self.assertEqual(stops("managed"), [(21, 'breakdown', 'block_assembly'), (57, 'breakdown', 'block_assembly'), (58, 'breakdown', 'erection'), (95, 'breakdown', 'erection')])
        self.assertEqual(stops("all_in"), [(13, 'accident', 'processing'), (19, 'breakdown', 'block_assembly'), (23, 'accident', 'block_assembly'), (25, 'accident', 'sub_assembly'), (39, 'accident', 'erection'), (43, 'accident', 'pre_outfitting'), (46, 'accident', 'block_assembly'), (48, 'breakdown', 'erection'), (51, 'breakdown', 'block_assembly'), (65, 'accident', 'erection')])


def preset_full(preset_id):
    """프리셋 사본. 3.x 프리셋에 없는 공정(도장·선행의장·안벽의장·시운전)은 엔진 기본값으로 채워 둔다(4.0)."""
    cfg = copy.deepcopy(PRESETS[preset_id])
    for pid in STATIONS:
        cfg["stations"].setdefault(pid, {"method": "standard", "overtime": False, "maintenance": True})
    return cfg


def variant(preset_id, pool, transporters=1, maintained=True, research=(), method=None, maintenance=None):
    """프리셋 변형. pool = 직종마다 인원(4.0: 직종별 대기소, D42)"""
    cfg = preset_full(preset_id)
    cfg["pools"] = {t: pool for t in cfg["pools"]}
    cfg["transporters"] = {"count": transporters, "maintenance": maintained}
    cfg["forklifts"] = {**cfg["forklifts"], "maintenance": maintained}
    cfg["research"] = list(research)
    for st in cfg["stations"].values():
        if method is not None:
            st["method"] = method
        if maintenance is not None:
            st["maintenance"] = maintenance
    return cfg


def crew(preset_id, **crews):
    """프리셋의 공정 인력을 바꾼 설정(2.0 4M). crew("managed", erection="normal")"""
    cfg = preset_full(preset_id)
    for pid, c in crews.items():
        cfg["stations"][pid]["crew"] = c
    return cfg


def mats(preset_id, **grades):
    """프리셋의 자재 등급을 바꾼 설정. mats("managed", paper="cheap")"""
    cfg = copy.deepcopy(PRESETS[preset_id])
    cfg["materials"] = grades
    return cfg


def method(preset_id, name, *stations):
    """프리셋의 몇몇 공정 공법을 바꾼 설정."""
    cfg = preset_full(preset_id)
    for pid in stations:
        cfg["stations"][pid]["method"] = name
    return cfg


class GradeTable(unittest.TestCase):
    """10장의 등급 표: (설정, 이익, 납기 준수 척수, 점수, 등급). 4.0 물류 전담 뒤의 "4.3.0 조율 값"(D40).
    트랜스포터는 역할마다 한 대로 고정돼(D39) 대수를 바꾼 줄은 뺐다."""

    ROWS = [
        ("무관리", PRESETS["unmanaged"], -24900.4, 4, 49.3, "F"),
        ("전부 최대 투입", PRESETS["all_in"], -27671.0, 6, 57.8, "C"),
        ("관리", PRESETS["managed"], 10298.6, 6, 88.4, "A"),
        ("관리, 직종마다 3명", variant("managed", 3), 5508.6, 6, 75.2, "B"),
        ("관리, 직종마다 1명", variant("managed", 1), -39700.8, 0, 20.0, "F"),
        ("관리 + 공정 자동화, 직종마다 1명", variant("managed", 1, research=["automation"]), 11602.0, 0, 72.0, "B"),
        ("속성 + 자동 검사 → 자동화", variant("managed", 2, research=["auto_inspect", "automation"], method="fast"), 10515.2, 6, 88.5, "A"),
        ("정비 생략 + 예지 정비 → 자동화, 트랜스포터·지게차 미정비", variant("managed", 2, 1, False, ["predictive", "automation"], maintenance=False), 10860.8, 5, 86.1, "A"),
        ("관리, 탑재 숙련공 → 일반", crew("managed", erection="normal"), 10748.6, 6, 89.7, "A"),
        ("관리, 중조립 로봇", crew("managed", block_assembly="robot"), 9482.6, 6, 86.2, "A"),
        ("관리, 휴지·저가 물감·저가 깃발", mats("managed", paper="cheap", paint="cheap", flag="cheap"), 10904.3, 5, 86.7, "A"),
        ("관리, 전 공정 신공법", method("managed", "new", *STATIONS), 8126.8, 6, 82.4, "B"),
    ]

    def test_rows(self):
        for name, cfg, profit, on_time, score, grade in self.ROWS:
            with self.subTest(name):
                r = open_sim(cfg)
                self.assertAlmostEqual(r["profit"], profit, places=2)
                self.assertEqual(r["qcd"]["delivery"]["on_time"], on_time)
                self.assertEqual((r["grade"]["score"], r["grade"]["grade"]), (score, grade))

    def test_baseline_line(self):
        g = open_sim(variant("managed", 1, research=["automation"]))["grade"]
        self.assertEqual(g["baseline"]["name"], "전부 최대 투입")
        self.assertEqual((g["baseline"]["score"], g["baseline"]["grade"]), (57.8, "C"))
        self.assertEqual(g["vs_baseline"], {'profit': 39273.0, 'pool': -31, 'score': 14.2})

    def test_parts_add_up(self):
        g = open_sim(PRESETS["managed"])["grade"]
        self.assertEqual([p["key"] for p in g["parts"]], ["revenue", "profit", "delivery", "quality"])
        self.assertAlmostEqual(sum(p["points"] for p in g["parts"]), g["score"], places=1)

    def test_one_ship_scenario_has_no_baseline(self):
        g = simulate(one_ship_config(), one_ship_scenario(FULL))["grade"]
        self.assertIsNone(g["baseline"])


class Research(unittest.TestCase):
    def test_queue_runs_one_after_another(self):
        r = simulate(variant("managed", 2, research=["auto_inspect", "automation"]))
        self.assertEqual([(x["id"], x["start"], x["end"]) for x in r["research"]],
                         [("auto_inspect", 1, 8), ("automation", 9, 20)])
        self.assertEqual([(e["day"], e["research"]) for e in r["events"] if e["type"] == "research_done"],
                         [(8, "auto_inspect"), (20, "automation")])
        self.assertEqual(r["costs"]["research"], 800)

    def test_predictive_stops_every_breakdown(self):
        r = simulate(variant("unmanaged", 4, research=["predictive"]))
        self.assertTrue(all(e["day"] <= 8 for e in r["events"] if e["type"] == "breakdown"))


class Ordering(unittest.TestCase):
    """발주 방식: bulk(1일에 전부), jit(필요일 − 리드타임 − 여유 0일), late(필요일에).
    필요일은 그 자재를 출고하는 날이다. 4.0부터는 키트를 싣는 날(4.3부터 지게차)(앞 공정에 들어간 다음 날, 소조립은 착수일)."""

    def order_days(self, preset_id, ordering=None):
        cfg = copy.deepcopy(PRESETS[preset_id])
        if ordering:
            cfg["ordering"] = ordering
        return {s["id"]: s["order_days"] for s in simulate(cfg, baseline=False)["ships"]}

    def test_bulk_orders_everything_on_day_1(self):
        self.assertEqual(self.order_days("all_in"), {sid: {"paper": 1, "paint": 1, "flag": 1} for sid in PRESETS["all_in"]["ships"]})

    def test_jit_counts_back_from_the_day_of_need(self):
        # 물감은 도장, 깃발은 안벽의장(4.0)의 키트를 싣는 날이 필요일이다
        self.assertEqual(self.order_days("managed")["S1"], {"paper": 1, "paint": 10, "flag": 23})
        # 여유 0일이어도 입고가 하루 순서의 맨 앞이라 자재 대기가 없다.
        r = simulate(PRESETS["managed"])
        self.assertEqual(sum(s["lead_time_parts"]["material_wait"] for s in r["ships"]), 0)
        self.assertEqual(self.order_days("managed"), suggest_order_days(PRESETS["managed"], buffer_days=0))

    def test_late_orders_on_the_day_of_need(self):
        # 무관리는 우선순위가 납기 반대(4.2)라 S6이 1순위다.
        self.assertEqual(self.order_days("unmanaged")["S6"], {"paper": 1, "paint": 7, "flag": 24})
        # S6 절단(종이를 쓰는 첫 공정): 1일에 발주한 종이가 3일에 들어와 리드타임 2일이 그대로 자재 대기가 된다.
        s6 = simulate(PRESETS["unmanaged"])["ships"][5]
        self.assertEqual(segments(s6, "cutting")[0], ("material_wait", 1, 2))
        self.assertEqual(s6["arrival_days"]["flag"], 34)

    def test_explicit_order_days_still_work(self):
        # 1.0 설정(ordering 없이 order_days를 직접 적음)은 그대로 돈다.
        cfg = copy.deepcopy(PRESETS["managed"])
        resolved = self.order_days("managed")
        del cfg["ordering"]
        for sid, days in resolved.items():
            cfg["ships"][sid]["order_days"] = days
        self.assertEqual(simulate(cfg)["profit"], simulate(PRESETS["managed"])["profit"])

    def test_unknown_ordering_is_rejected(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["ordering"] = "someday"
        with self.assertRaises(ConfigError):
            simulate(cfg)


class Contract(unittest.TestCase):
    def test_same_config_same_result(self):
        self.assertEqual(simulate(PRESETS["unmanaged"]), simulate(PRESETS["unmanaged"]))

    def test_config_is_not_modified(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        simulate(cfg)
        self.assertEqual(cfg, PRESETS["managed"])

    def test_every_day_is_recorded(self):
        r = simulate(PRESETS["unmanaged"])
        for ship in r["ships"]:
            self.assertEqual(len(ship["daily"]), r["days"])
        for st in r["stations"]:
            self.assertEqual(len(st["daily"]), r["days"])
        for tr in r["transporters"] + r["forklifts"]:
            self.assertEqual(len(tr["daily"]), r["days"])
        self.assertEqual(len(r["inventory_daily"]), r["days"])
        self.assertEqual(len(r["workforce"]["daily"]), r["days"])

    def test_inventory_value_is_the_base_of_holding_cost(self):
        r = simulate(PRESETS["all_in"])
        self.assertEqual(len(r["inventory_value_daily"]), r["days"])
        # 재고비 = (창고 재고 + 작업장 앞 키트, 4.1) 금액 × 1%
        self.assertEqual(len(r["onsite_value_daily"]), r["days"])
        self.assertAlmostEqual((sum(r["inventory_value_daily"]) + sum(r["onsite_value_daily"])) * 0.01, r["costs"]["holding"], places=2)

    def test_assigned_workers_never_exceed_pool(self):
        for cfg in PRESETS.values():
            r = simulate(cfg)
            for day in range(r["days"]):
                on_stations = sum(u["daily"][day]["workers"] for st in r["stations"] for u in st["units"])
                self.assertEqual(on_stations, r["workforce"]["daily"][day]["assigned"])
                self.assertLessEqual(on_stations, r["workforce"]["pool"])   # 직종 인원 합(4.0)

    def test_findings_are_loss_segments_longest_first(self):
        f = simulate(PRESETS["managed"])["findings"]
        self.assertEqual(f[0], {"kind": "labor_wait", "ship": "S3", "station": "sub_assembly",
                                "start": 28, "end": 31, "days": 4})
        self.assertEqual([x["days"] for x in f], sorted((x["days"] for x in f), reverse=True))

    def test_preview(self):
        p = preview(variant("managed", 6, research=["auto_inspect"]))
        # 탑재는 숙련공(불량률 −8%p), 자동 검사 −5%p. 숙련공 할증은 일한 날마다 붙어 고정비에 없다.
        self.assertEqual(p["stations"]["erection"], {"rate": 2.0, "defect_rate": 0.02, "defect_rate_final": 0.0})
        self.assertEqual(p["fixed_costs"],
                         {"labor": 36000, "maintenance": 1000, "transporter": 1950, "investment": 0, "research": 300})   # 직종마다 6명 × 1,200
        # 운반 설비(4.3): 트랜스포터 1대 650 + 지게차 2대 × (5 × 120일 + 정비 50) = 1,950
        self.assertEqual([(x["id"], x["end"]) for x in p["research"]], [("auto_inspect", 8)])
        # 깃발은 안벽의장(4.0)에서 쓴다. 필요일 = 지게차가 안벽의장 키트를 싣는 날(탑재에 들어간 다음 날). JIT는 리드타임 10일 앞.
        flag = p["materials"]["S1"]["flag"]
        self.assertEqual(flag["arrival_day"] - flag["order_day"], 10)

    def test_plan_bars_match_the_run_when_nothing_gets_in_the_way(self):
        # 손 계산 예시 1(한 척, 막힘 없음)은 계획 막대가 실제 구간과 같다.
        plan = preview(one_ship_config(), one_ship_scenario(FULL))["plan"]
        run = simulate(one_ship_config(), one_ship_scenario(FULL), baseline=False)
        self.assertEqual(plan["ships"]["S1"], run["ships"][0]["spans"])
        # 관리 프리셋(4.0 반기)은 조립 2명이 소조립·중조립·PE장을 나눠 써서 계획보다 늦는 배가 있다(계획은 사람을 혼자 쓴다고 본 일정).
        # S1·S2가 중조립 19일과 탑재 33~36일(탑재가 7~8일로 길어진 4.2)에 겹친다.
        plan = preview(PRESETS["managed"])["plan"]
        self.assertIn({"station": "block_assembly", "ships": ["S1", "S2"], "start": 19, "end": 19}, plan["conflicts"])
        self.assertIn({"station": "erection", "ships": ["S1", "S2"], "start": 33, "end": 36}, plan["conflicts"])

    def test_invalid_config_is_rejected(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["pools"]["assembly"] = 13   # 조립 상한 12명(D30·D42)
        cfg["ships"]["S2"]["priority"] = 1
        cfg["research"] = ["automation", "automation"]
        with self.assertRaises(ConfigError) as ctx:
            simulate(cfg)
        self.assertEqual(len(ctx.exception.messages), 3)



def with_assembly(cfg, n):
    """조립 직종 인원만 바꾼 설정(4.0: 직종별 대기소)"""
    return {**cfg, "pools": {**cfg["pools"], "assembly": n}}


def expanded(preset, **units):
    """프리셋에 공정별 작업장 수를 더한 설정. expanded("all_in", block_assembly=2)"""
    cfg = preset_full(preset)
    for pid, n in units.items():
        cfg["stations"][pid]["units"] = n
    return cfg


class Expansion(unittest.TestCase):
    """2.0 작업장 증설: 같은 공정에 작업장을 2개까지 두어 서로 다른 배를 동시에 처리한다."""

    def test_one_unit_is_the_same_as_no_setting(self):
        # 1.x 설정(units 없음)과 모든 공정 1개는 결과가 같다.
        for pid in PRESETS:
            self.assertEqual(open_sim(expanded(pid, **{s: 1 for s in STATIONS})), open_sim(PRESETS[pid]))

    def test_two_units_work_on_two_ships_at_once(self):
        r = open_sim(expanded("all_in", block_assembly=2), baseline=False)
        block = next(st for st in r["stations"] if st["id"] == "block_assembly")
        self.assertEqual([u["unit"] for u in block["units"]], [1, 2])
        both = [d for d in range(r["days"]) if all(u["daily"][d]["ship"] for u in block["units"])]
        self.assertTrue(both)
        ships = {u["daily"][both[0]]["ship"] for u in block["units"]}
        self.assertEqual(len(ships), 2)

    def test_expansion_cuts_station_wait_at_that_station(self):
        def waits(cfg):
            r = open_sim(cfg, baseline=False)
            return sum(1 for s in r["ships"] for d in s["daily"]
                       if d["state"] == "station_wait" and d["station"] == "block_assembly")
        self.assertLess(waits(expanded("all_in", block_assembly=2)), waits(PRESETS["all_in"]))

    def test_expansion_cost_and_maintenance_per_unit(self):
        p = open_preview(expanded("all_in", block_assembly=2, erection=2))
        self.assertEqual(p["fixed_costs"]["investment"], 300 + 800)
        # 정비비는 작업장마다: 공정 10개(4.0) + 증설 2곳 = 12곳
        self.assertEqual(p["fixed_costs"]["maintenance"], 12 * 100)

    def test_plan_overlap_only_when_more_ships_than_units(self):
        plan = open_preview(expanded("managed", block_assembly=2))["plan"]
        self.assertFalse([c for c in plan["conflicts"] if c["station"] == "block_assembly"])

    def test_unit_is_recorded_on_ships_and_events(self):
        r = open_sim(expanded("all_in", block_assembly=2), baseline=False)
        enters = [e for e in r["events"] if e["type"] == "enter" and e["station"] == "block_assembly"]
        self.assertEqual({e["unit"] for e in enters}, {1, 2})
        on_unit_2 = [d for s in r["ships"] for d in s["daily"] if d.get("unit") == 2]
        self.assertTrue(on_unit_2)

    def test_too_many_units_is_rejected(self):
        # 3.0: 작업장은 공정마다 3개까지(D30)
        with self.assertRaises(ConfigError):
            open_sim(expanded("managed", block_assembly=4))



GROWTH = {p["id"]: p["config"] for p in load_presets("growth")}


class FourM(unittest.TestCase):
    """2.0 4M 선택지: 인력(일반·숙련공·로봇), 신공법(학습 곡선), 자재 등급(표준·저가)."""

    def test_skilled_crew_premium_is_per_worker_day(self):
        r = open_sim(PRESETS["managed"])
        erection = next(st for st in r["stations"] if st["id"] == "erection")
        worked = sum(d["workers"] for d in erection["daily"])
        # 인건비 = 직종 인원(조립 3, 나머지 2명씩 = 11명, 4.2) × 10 × 120일 + 숙련공 할증 + 시운전 외부팀(일한 날 × 20, 4.0)
        trial = next(st for st in r["stations"] if st["id"] == "sea_trial")
        trial_days = sum(1 for d in trial["daily"] if d["state"] in ("work", "rework"))
        self.assertEqual(r["costs"]["labor"], 11 * 10 * 120 + worked * 5 + trial_days * 20)

    def test_robot_needs_nobody_and_costs_install(self):
        r = open_sim(crew("managed", block_assembly="robot"), baseline=False)
        block = next(st for st in r["stations"] if st["id"] == "block_assembly")
        self.assertTrue(all(d["workers"] == 0 for d in block["daily"]))
        self.assertEqual(block["labor_wait_days"], 0)
        self.assertEqual(r["costs"]["investment"], 700)

    def test_new_method_learns(self):
        # 신공법 불량률: 0.30에서 로트를 끝낼 때마다 0.10씩 내려가 0.05에서 멈춘다(정비함, 일반 인력).
        from shipyard.sim import station_defect_rate
        sc = load_scenario()
        cfg = {"method": "new", "overtime": False, "maintenance": True, "crew": "normal"}
        self.assertEqual([station_defect_rate(cfg, "normal", sc, lots_done=n) for n in range(5)],
                         [0.3, 0.2, 0.1, 0.05, 0.05])

    def test_cheap_material_halves_price_and_adds_defects(self):
        cheap = open_sim(mats("managed", paper="cheap", paint="cheap", flag="cheap"), baseline=False)
        self.assertEqual(cheap["costs"]["material"], 3060 / 2)   # 기본 반기 6척의 자재비 3,060
        st = next(s for s in cheap["stations"] if s["id"] == "cutting")   # 종이를 쓰는 공정(4.0: 절단)
        self.assertEqual(st["defect_rate"], 0.10 + 0.30)

    def test_robot_does_no_overtime(self):
        cfg = crew("unmanaged", sub_assembly="robot")
        r = open_sim(cfg, baseline=False)
        self.assertFalse([e for e in r["events"] if e["type"] == "accident" and e["station"] == "sub_assembly"])

    def test_old_senior_reads_as_skilled_crew(self):
        # 하위 호환: 1.x 설정의 skilled_station은 그 공정의 숙련공이다.
        old = copy.deepcopy(PRESETS["managed"])
        del old["stations"]["erection"]["crew"]
        old["skilled_station"] = "erection"
        self.assertEqual(open_sim(old)["profit"], open_sim(PRESETS["managed"])["profit"])


class Scenarios(unittest.TestCase):
    """2.0 시나리오 둘: 기본 분기(4척)와 수주 증가(6척, LNG선 2척). 규칙은 함께 쓴다."""

    def test_list(self):
        self.assertEqual([(s["id"], s["name"], s["ships"]) for s in list_scenarios()],
                         [("basic", "기본 반기", 6), ("growth", "수주 증가", 8), ("surge", "수주 급증", 10)])

    def test_config_without_scenario_runs_as_basic(self):
        # 하위 호환: 1.x 설정(scenario 없음)은 기본 분기로 돈다.
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["scenario"] = "basic"
        self.assertEqual(simulate(cfg)["profit"], simulate(PRESETS["managed"])["profit"])

    def test_growth_presets(self):
        # 4.3.0 조율 값(D40)
        cases = {'unmanaged': (-31615.4, 44.7, 'F'), 'managed': (18148.2, 88.5, 'A'), 'all_in': (-21037.8, 56.1, 'C')}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(GROWTH[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)
            self.assertEqual(r["grade"]["baseline"]["score"], 56.1)

    def test_growth_has_lng(self):
        sc = load_scenario("growth")
        self.assertEqual([o["type"] for o in sc["orders"]], ["VLCC", "CONT", "VLCC", "LNG", "CONT", "VLCC", "LNG", "CONT"])
        # LNG선은 의장이 많다: 4.0부터 안벽의장 10(3.x는 탑재 18에 들어 있었다). 탑재는 4.2에 도크가 병목이 되게 16
        self.assertEqual((sc["ship_types"]["LNG"]["work"]["erection"], sc["ship_types"]["LNG"]["work"]["quay_outfitting"]), (16, 10))
        self.assertEqual(sc["kpi"]["revenue"], 51600)   # 4.0: 반기 8척, 선가 2배(D44)

    def test_bottleneck_expansion_beats_expanding_everything(self):
        # 수주 증가의 교육 포인트: 병목만 증설한 관리 프리셋이 전부 증설보다 낫다.
        managed = simulate(GROWTH["managed"], baseline=False)
        everything = copy.deepcopy(GROWTH["managed"])
        for st in everything["stations"].values():
            st["units"] = 2
        self.assertGreater(managed["profit"], simulate(everything, baseline=False)["profit"])

    def test_unknown_or_mismatched_scenario_is_rejected(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["scenario"] = "nope"
        with self.assertRaises(ConfigError):
            simulate(cfg)
        cfg["scenario"] = "growth"
        with self.assertRaises(ConfigError):
            simulate(cfg, load_scenario("basic"))



def as_areas(cfg, **over):
    """2.x 설정을 3.0 모양(areas)으로 바꾼다. over로 공정마다 바꿀 값(stations, split 등)을 준다."""
    c = copy.deepcopy(cfg)
    c["areas"] = {pid: {**{k: v for k, v in st.items() if k != "units"}, "stations": st.get("units", 1)}
                  for pid, st in c.pop("stations").items()}
    for pid, v in over.items():
        c["areas"][pid].update(v)
    return c


class AreasAndSplit(unittest.TestCase):
    """3.0(규칙 문서 3장 나눠 하기, 10장 예시 4): 공정 = 구역, 작업장 1~3개, 공정마다 4M, 나눠 하기."""

    def test_areas_form_gives_the_same_result(self):
        # 하위 호환: 같은 설정을 areas로 적어도 결과가 같다.
        for pid in ("unmanaged", "managed", "all_in"):
            self.assertEqual(open_sim(as_areas(PRESETS[pid]))["profit"], open_sim(PRESETS[pid])["profit"], pid)
        self.assertEqual(open_sim(as_areas(GROWTH["managed"]))["profit"], open_sim(GROWTH["managed"])["profit"])

    def test_split_without_extra_station_changes_nothing(self):
        cfg = with_assembly(PRESETS["managed"], 4)
        plain = open_sim(as_areas(cfg), baseline=False)
        split = open_sim(as_areas(cfg, block_assembly={"split": True}), baseline=False)
        self.assertEqual(split["profit"], plain["profit"])

    def test_split_divides_work_and_waits_for_the_pair(self):
        # 관리안(기본 반기)에 조립 4명, 중조립 2곳 나눠 하기(4.3.0 조율 값, D40).
        cfg = as_areas(with_assembly(PRESETS["managed"], 4), block_assembly={"stations": 2, "split": True})
        r = open_sim(cfg)
        self.assertEqual((r["grade"]["grade"], r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), ("A", 85.3, 6))
        # 들어갈 때 빈 작업장 수만큼 나눈다. 반기에는 배 사이가 넉넉해 여섯 척 모두 2곳에 나눠 들어간다.
        # 투입 기록은 배마다 하나(나눠 들어가면 units에 작업장 목록). 검사는 배 한 척에 한 번이다.
        enters = [e for e in r["events"] if e["type"] == "enter" and e["station"] == "block_assembly"]
        self.assertEqual([e.get("units") for e in enters], [[1, 2]] * 6)
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual(block["inspections"], 6)
        parts = [d["parts"] for s in r["ships"] for d in s["daily"] if "parts" in d]
        self.assertTrue(parts and all(len(p) == 2 for p in parts))

    def test_expanding_without_split_does_not_fix_the_delay(self):
        # 기본 반기(4.0)는 공장 능력이 남아 관리안에 지연이 없다. 그래서 여기서는 값만 적고,
        # "나눠 하기가 일정을 살린다"는 비교는 수주 급증(Surge.test_split_is_what_saves_the_schedule)이 맡는다.
        cfg = as_areas(with_assembly(PRESETS["managed"], 4), block_assembly={"stations": 2})
        r = open_sim(cfg)
        self.assertEqual((r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), (84.5, 6))

    def test_plan_bar_uses_part_work(self):
        # 계획 막대: 나눠 하기를 켠 공정은 작업장을 모두 쓴다고 보고 부분 작업량으로 잰다(S1 중조립 16 ÷ 2곳 ÷ 2/일 = 4일).
        plan = open_preview(as_areas(PRESETS["managed"], block_assembly={"stations": 2, "split": True}))["plan"]
        span = plan["ships"]["S1"]["block_assembly"]
        self.assertEqual(span["end"] - span["start"] + 1, 4)

    def test_erection_is_never_split(self):
        cfg = as_areas(GROWTH["managed"], erection={"stations": 2, "split": True})
        r = open_sim(cfg, baseline=False)
        self.assertFalse([d for s in r["ships"] for d in s["daily"] if "parts" in d and d["station"] == "erection"])

    def test_limits(self):
        cfg = as_areas(PRESETS["managed"], block_assembly={"stations": 3, "split": True})
        cfg["pool"] = 12
        open_sim(cfg)   # 3곳, 12명까지는 된다
        cfg["areas"]["block_assembly"]["split"] = "yes"
        with self.assertRaises(ConfigError):
            open_sim(cfg)


SURGE = {p["id"]: p["config"] for p in load_presets("surge")}


class Surge(unittest.TestCase):
    """3.0 새 분기 "수주 급증"(8척): 3호 작업장과 나눠 하기의 판단 거리."""

    def test_presets(self):
        # 4.3.0 조율 값(D40). 블록 운반이 한 대로 줄어 관리안도 한 척 지연(7/8)
        cases = {'unmanaged': (-42029.2, 44.0, 'F'), 'managed': (25595.8, 89.3, 'A'), 'all_in': (-11140.2, 57.3, 'C')}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(SURGE[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)

    def test_split_is_what_saves_the_schedule(self):
        # 관리안에서 나눠 하기만 끄면 더 늦는다. 4.0 공정 그래프 뒤(조율 전, D40)에는 둘 다 납기를 못 지켜 총 지연일로 비교한다.
        off = copy.deepcopy(SURGE["managed"])
        off["stations"]["block_assembly"]["split"] = False
        on = simulate(SURGE["managed"], baseline=False)
        self.assertLess(on["qcd"]["delivery"]["total_late_days"], simulate(off, baseline=False)["qcd"]["delivery"]["total_late_days"])



class LevelOptions(unittest.TestCase):
    """분기(난이도)별 옵션(D33): 쉬운 분기는 옵션을 가리고, 엔진이 숨긴 옵션을 쓴 설정을 거절한다."""

    def test_presets_use_only_open_options(self):
        for sid in ("basic", "growth", "surge"):
            for p in load_presets(sid):
                simulate(p["config"], baseline=False)   # 거절되지 않는다

    def test_basic_locks_robot_new_method_cheap_and_expansion(self):
        cases = [
            ("crew", lambda c: c["stations"]["block_assembly"].update(crew="robot"), "인력 '로봇'"),
            ("method", lambda c: c["stations"]["block_assembly"].update(method="new"), "공법 '신공법'"),
            ("cheap", lambda c: c.update(materials={"paper": "cheap"}), "자재 등급 '저가'"),
            ("units", lambda c: c["stations"]["block_assembly"].update(units=2), "작업장을 1개까지"),
            ("split", lambda c: c["stations"]["block_assembly"].update(split=True), "나눠 하기"),
        ]
        for name, change, words in cases:
            cfg = copy.deepcopy(PRESETS["managed"])
            change(cfg)
            with self.assertRaises(ConfigError, msg=name) as ctx:
                simulate(cfg)
            self.assertIn(words, " ".join(ctx.exception.messages), name)
        # 숙련공은 1단계에도 열려 있다(1.x 시니어, D33).
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["stations"]["block_assembly"]["crew"] = "skilled"
        simulate(cfg, baseline=False)

    def test_growth_allows_two_units_but_not_three_or_split(self):
        cfg = copy.deepcopy(GROWTH["managed"])
        cfg["stations"]["block_assembly"]["units"] = 3
        with self.assertRaises(ConfigError):
            simulate(cfg)
        cfg["stations"]["block_assembly"].update(units=2, split=True)
        with self.assertRaises(ConfigError):
            simulate(cfg)

    def test_erection_docks_need_a_crane_each(self):
        # 탑재 도크마다 골리앗 크레인(걸리버의 두 손)이 있어야 해서 3.0에서도 2곳까지다.
        cfg = copy.deepcopy(SURGE["managed"])
        cfg["stations"]["erection"]["units"] = 3
        with self.assertRaises(ConfigError):
            simulate(cfg)

    def test_surge_opens_everything(self):
        cfg = copy.deepcopy(SURGE["managed"])
        cfg["stations"]["block_assembly"].update(units=3, split=True, crew="robot", method="new")
        cfg["materials"] = {"paint": "cheap"}
        simulate(cfg, baseline=False)


class Pegging(unittest.TestCase):
    """자재 페깅(3.1, 기록만): 공용 재고를 몫(배)별로도 남긴다. 규칙과 숫자는 그대로다."""

    def test_pegging_adds_up_to_stock_every_day(self):
        for sid in ("basic", "growth", "surge"):
            for preset in load_presets(sid):
                r = simulate(preset["config"], baseline=False)
                for day, stock in enumerate(r["inventory_daily"]):
                    for mid, qty in stock.items():
                        self.assertEqual(sum(x["quantity"] for x in r["pegging_daily"][day][mid]), qty, (sid, preset["id"], day, mid))

    def test_planned_presets_never_borrow(self):
        # B안(JIT)과 C안(일괄)은 배마다 자기 필요일에 맞춰 발주해서 남의 몫을 빌릴 일이 없다.
        for sid in ("basic", "growth", "surge"):
            for preset in load_presets(sid):
                if preset["id"] == "unmanaged":
                    continue
                r = simulate(preset["config"], baseline=False)
                for ev in (e for e in r["events"] if e["type"] == "issue"):
                    self.assertEqual(ev["from"], [{"ship": ev["ship"], "quantity": ev["quantity"]}])

    def test_unmanaged_borrows_when_the_schedule_slips(self):
        # A안(무관리, 늦은 발주)은 일정이 발주 때 본 필요일과 어긋나면 남의 몫을 빌린다(4.2): 수주 증가에서 S6이 S5 몫 깃발을 쓴다.
        r = simulate(next(p for p in load_presets("growth") if p["id"] == "unmanaged")["config"], baseline=False)
        borrowed = [(e["day"], e["ship"], e["material"], e["from"]) for e in r["events"]
                    if e["type"] == "issue" and e["from"] != [{"ship": e["ship"], "quantity": e["quantity"]}]]
        self.assertEqual(borrowed[0], (56, "S6", "flag", [{"ship": "S5", "quantity": 2}]))

    def test_own_first_then_borrow_oldest(self):
        # 배별 발주일(1.0 방식): S3 종이를 1일에(3일 입고), S1 종이를 3일에(5일 입고) 발주한다.
        # 3일에 S1은 자기 몫이 없어 S3 몫을 빌리고, 24일에 S3은 S1 몫을 빌린다. 12일의 S2는 S1 몫이 선반에 있어도 자기 몫을 쓴다.
        base = PRESETS["managed"]
        cfg = copy.deepcopy(base)
        cfg.pop("ordering")
        for sid, days in resolve_order_days(base).items():
            cfg["ships"][sid]["order_days"] = dict(days)
        cfg["ships"]["S3"]["order_days"]["paper"] = 1
        cfg["ships"]["S1"]["order_days"]["paper"] = 3
        r = simulate(cfg, baseline=False)
        issues = {e["ship"]: e for e in r["events"] if e["type"] == "issue" and e["material"] == "paper"}
        self.assertEqual((issues["S1"]["day"], issues["S1"]["from"]), (3, [{"ship": "S3", "quantity": 8}]))
        self.assertEqual((issues["S2"]["day"], issues["S2"]["from"]), (12, [{"ship": "S2", "quantity": 6}]))
        self.assertEqual((issues["S3"]["day"], issues["S3"]["from"]), (24, [{"ship": "S1", "quantity": 8}]))
        self.assertEqual(r["pegging_daily"][9]["paper"], [{"ship": "S1", "quantity": 8}])   # 10일 끝: S1 몫 8장이 선반에
        # 일정은 관리 프리셋과 같고, S3 종이가 19일 일찍 들어와(JIT 22일 발주 → 1일) 재고비만 160 × 1% × 19일 = 30.4 늘었다.
        b = simulate(base, baseline=False)
        self.assertEqual([s["daily"] for s in r["ships"]], [s["daily"] for s in b["ships"]])
        self.assertAlmostEqual(r["costs"]["holding"] - b["costs"]["holding"], 30.4)
        self.assertAlmostEqual(r["profit"] - b["profit"], -30.4)

    def test_take_order(self):
        # 자기 몫 → 공용(처음 재고) → 남의 몫(먼저 들어온 것부터)
        batches = [[0, None, 2], [1, "S2", 3], [2, "S3", 3], [4, "S1", 1]]
        self.assertEqual(_take_pegged(batches, "S1", 6),
                         [{"ship": "S1", "quantity": 1}, {"ship": None, "quantity": 2}, {"ship": "S2", "quantity": 3}])
        self.assertEqual(batches, [[2, "S3", 3]])



class ForkliftPool(unittest.TestCase):
    """공용 지게차(4.3, D46): 자재 키트와 가공 → 소조립 부재 팔레트를 차고의 지게차가 함께 나른다. 트랜스포터는 블록 한 대."""

    def test_kits_and_pallets_share_forklifts(self):
        # 기본 반기 B안 15일: F1이 S1 물감 키트(우선순위 1)와 S2 부재 팔레트를 하루 2건 다 맡고, F2는 쉰다.
        r = simulate(PRESETS["managed"], baseline=False)
        day = 15
        self.assertEqual([(j["kind"], j["ship"]) for j in r["forklifts"][0]["daily"][day - 1]["jobs"]],
                         [("kit", "S1"), ("pallet", "S2")])
        self.assertEqual(r["forklifts"][1]["daily"][day - 1], {"state": "idle", "jobs": []})
        self.assertEqual([t["id"] for t in r["transporters"]], ["TR"])

    def test_one_forklift_makes_a_pallet_wait(self):
        # 수주 급증 B안을 지게차 1대로: 27일에 키트 두 건(S1·S2, 우선순위가 앞)이 하루 몫을 다 써서
        # S5 부재 팔레트는 하루 운반 대기, 다음 날 실린다. 2대면 대기가 없다.
        def pallet_waits(n):
            cfg = copy.deepcopy(SURGE["managed"])
            cfg["forklifts"]["count"] = n
            r = simulate(cfg, baseline=False)
            return [(s["id"], d) for s in r["ships"] for d, x in enumerate(s["daily"], start=1)
                    if x["state"] == "transport_wait" and x["station"] == "processing"]
        self.assertEqual(pallet_waits(1), [("S5", 27)])
        self.assertEqual(pallet_waits(2), [])

    def test_cost_per_forklift(self):
        # 지게차 한 대 = 5 × 120일 + 정비 50 = 650(운반 설비 원가에 넣는다)
        cfg = copy.deepcopy(GROWTH["managed"])
        costs = []
        for n in (1, 2, 3):
            cfg["forklifts"]["count"] = n
            costs.append(preview(cfg)["fixed_costs"]["transporter"])
        self.assertEqual([b - a for a, b in zip(costs, costs[1:])], [650, 650])

    def test_old_config_gets_two_forklifts(self):
        # 4.2 이전 설정(forklifts 없음)은 기본 2대, 정비는 트랜스포터 정비를 따른다
        cfg = copy.deepcopy(PRESETS["unmanaged"])
        cfg.pop("forklifts")
        r = simulate(cfg, baseline=False)
        self.assertEqual(len(r["forklifts"]), 2)
        self.assertEqual(r["costs"]["transporter"], 3 * 5 * 120)

    def test_limits(self):
        for n in (0, 4):
            cfg = copy.deepcopy(GROWTH["managed"])
            cfg["forklifts"]["count"] = n
            with self.assertRaises(ConfigError):
                simulate(cfg)
        # 기본 반기는 2대 고정(D33처럼 수주 증가부터 대수를 고른다)
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["forklifts"]["count"] = 3
        with self.assertRaises(ConfigError):
            simulate(cfg)
        self.assertEqual(open_sim(cfg, baseline=False)["forklifts"][2]["id"], "F3")


if __name__ == "__main__":
    unittest.main()
