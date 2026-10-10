"""규칙 문서 10장 "검증용 예시"의 값을 그대로 확인한다.

    python -m unittest discover -s engine/tests -t engine     (또는 pytest engine)

여기서 하나라도 깨지면 엔진이 규칙 문서와 달라진 것이다.
"""

import copy
import unittest

from shipyard import ConfigError, list_scenarios, load_presets, load_scenario, preview, simulate, suggest_order_days
from shipyard.sim import _take_pegged, resolve_order_days

PRESETS = {p["id"]: p["config"] for p in load_presets()}
STATIONS = ["sub_assembly", "block_assembly", "grand_assembly", "erection"]
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
    sc["orders"] = [o for o in sc["orders"] if o["id"] == "S1"]
    sc["initial_stock"] = stock
    sc["random"]["quality"] = {"S1": {s["id"]: quality for s in sc["stations"]}}
    return sc


def one_ship_config(order_days=None):
    """2명, 트랜스포터 1대(정비), 전 공정 표준·정비. 로트를 다 나르는 데 이틀 걸린다."""
    def station():
        return {"method": "standard", "overtime": False, "maintenance": True}
    return {
        "ships": {"S1": {"priority": 1, "start_day": 1, "order_days": order_days or {}}},
        "stations": {pid: station() for pid in STATIONS},
        "pool": 2,
        "transporters": {"count": 1, "maintenance": True},
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
    def test_example_1_schedule(self):
        r = simulate(one_ship_config(), one_ship_scenario(FULL))
        # 처리량 2/일. 블록 운반(T2)은 끝난 다음 날부터 6씩 이틀, 다 나른 둘째 날 바로 다음 공정에 들어간다.
        # PE장 → 탑재는 골리앗 크레인이 바로 든다(4.0): PE장을 18일에 끝내고 19일에 탑재.
        self.assertEqual(spans(r, "S1"), {"sub_assembly": (1, 4), "block_assembly": (6, 13),
                                          "grand_assembly": (15, 18), "erection": (19, 22)})
        self.assertEqual(segments(r["ships"][0]), [
            ("work", 1, 4), ("transport", 5, 5), ("work", 6, 13), ("transport", 14, 14),
            ("work", 15, 18), ("work", 19, 22)])
        self.assertEqual(r["ships"][0]["delivered_day"], 22)
        self.assertEqual(r["costs"]["wip"], 210)
        # 자재 키트(T1): 소조립 종이는 착수 하루 전(0일) 요청 → 1일, PE장 물감은 중조립에 들어간 6일 요청 → 7일,
        # 탑재 깃발은 PE장에 들어간 15일 요청 → 16일에 실어 작업장에 놓는다. 출고(issue)도 그날이다.
        self.assertEqual([(e["day"], e["material"], e["station"], e["transporter"]) for e in r["events"] if e["type"] == "issue"],
                         [(1, "paper", "sub_assembly", "T1"), (7, "paint", "grand_assembly", "T1"), (16, "flag", "erection", "T1")])
        # 중조립은 13일에 일한 날이 8일째라 고장 판정: 난수 0.05 < 정비 기준 0.1 → 고장. 배는 이미 끝나 손실은 없다.
        self.assertEqual([(e["day"], e["station"]) for e in r["events"] if e["type"] == "breakdown"],
                         [(13, "block_assembly")])
        self.assertEqual(r["costs"]["breakdown"], 150)
        # 트랜스포터는 역할마다 한 대(T1 자재, T2 블록): 2대 × (5 × 60일 + 정비 50) = 700.
        self.assertEqual(r["costs"]["transporter"], 700)

    def test_example_4_split(self):
        # 3.0 손 계산 예시 4: 예시 1에서 중조립만 작업장 2곳 + 나눠 하기, 대기소 4명.
        cfg = one_ship_config()
        cfg["pool"] = 4
        cfg["stations"]["block_assembly"].update({"units": 2, "split": True})
        r = simulate(cfg, one_ship_scenario(FULL))
        # 중조립 16을 2곳에 8씩, 곳마다 2명 → 4일(6~9일). 인도는 예시 1(22일)보다 4일 빠른 18일.
        self.assertEqual(spans(r, "S1"), {"sub_assembly": (1, 4), "block_assembly": (6, 9),
                                          "grand_assembly": (11, 14), "erection": (15, 18)})
        self.assertEqual(r["ships"][0]["delivered_day"], 18)
        self.assertEqual((r["costs"]["wip"], r["costs"]["labor"], r["costs"]["investment"], r["costs"]["maintenance"]),
                         (170, 2400, 300, 500))
        # 대기소가 2명이면 2호는 1호가 끝날 때까지 인력 대기, 그 뒤 1호가 짝 대기 → 나누지 않은 것과 같은 6~13일.
        cfg["pool"] = 2
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual(spans(r, "S1")["block_assembly"], (6, 13))
        parts = [[p["state"] for p in d["parts"]] for d in r["ships"][0]["daily"][5:13]]
        self.assertEqual(parts, [["work", "labor_wait"]] * 4 + [["pair_wait", "work"]] * 4)
        # 공정 결과의 짝 대기 일수: 1호가 4일 기다렸다(OEE에는 넣지 않는다).
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual((block["pair_wait_days"], [u["pair_wait_days"] for u in block["units"]]), (4, [4, 0]))
        # 3곳 + 6명이면 부분 5.33, 3일(6~8일), 인도 17일.
        cfg["pool"] = 6
        cfg["stations"]["block_assembly"]["units"] = 3
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual((spans(r, "S1")["block_assembly"], r["ships"][0]["delivered_day"]), ((6, 8), 17))

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
                         [("work", 6, 10), ("rework", 11, 13), ("transport", 14, 14)])
        self.assertEqual(r["ships"][0]["delivered_day"], 22)
        self.assertEqual(r["costs"]["rework"], 200)
        self.assertEqual(r["costs"]["overtime"], 80)
        self.assertEqual(r["costs"]["maintenance"], base["costs"]["maintenance"] - 100)
        self.assertEqual(r["total_cost"] - base["total_cost"], 180)

    def test_example_3_late_order(self):
        r = simulate(one_ship_config({"flag": 18}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        ship = r["ships"][0]
        # PE장을 18일에 끝내 19일부터 탑재할 수 있지만, 깃발이 28일에 들어와 T1이 그날 실어 온다. 19~27일 9일 자재 대기.
        self.assertEqual(spans(r, "S1")["erection"], (28, 31))
        self.assertEqual(ship["lead_time_parts"]["material_wait"], 9)
        self.assertEqual((ship["delivered_day"], ship["late_days"]), (31, 1))
        self.assertEqual(r["costs"]["late_penalty"], 90)
        self.assertEqual(r["costs"]["wip"], 300)

    def test_example_3_early_order(self):
        with_flag = simulate(one_ship_config({"flag": 1}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        self.assertEqual(with_flag["ships"][0]["delivered_day"], 22)
        # 깃발 키트는 16일에 실려 나간다(출고). 깃발 200어치를 11~15일 5일 보관: 200 × 1% × 5 = 10.
        # 기준 실행은 깃발을 1~15일 15일 동안 들고 있으므로 차이는 10일분 20이다.
        self.assertAlmostEqual(base["costs"]["holding"] - with_flag["costs"]["holding"], 20)


class Presets(unittest.TestCase):
    """10장의 프리셋 3개 기대 결과."""

    # 4.0 물류 전담(D39) 뒤의 값. 등급 구간은 버전을 올릴 때 조율한다(D40): "조율 전 값".
    EXPECTED = {
        "unmanaged": {
            "delivered": [29, 52, 44, 59], "late": [0, 14, 0, 3], "fpy": (5, 16), "on_time": 2,
            "accidents": 2, "breakdowns": 5, "man_days": 144,
            "costs": {'labor': 4800.0, 'overtime': 720.0, 'maintenance': 0, 'material': 2040.0, 'holding': 0.0, 'wip': 1460.0, 'rework': 2200.0, 'accident': 600.0, 'breakdown': 750.0, 'transporter': 600, 'investment': 0.0, 'research': 0, 'late_penalty': 1326.0},
            "total": 14496.0, "profit": -3296.0,
            "spans": {'S1': [(3, 5), (7, 14), (16, 20), (25, 29)], 'S2': [(13, 15), (28, 31), (33, 35), (48, 52)], 'S3': [(6, 10), (17, 27), (29, 31), (40, 44)], 'S4': [(16, 17), (32, 37), (39, 40), (53, 59)]},
            "parts": {'S1': [14, 7, 6, 0, 0, 2, 0, 0, 0], 'S2': [11, 4, 6, 19, 0, 2, 3, 5, 2], 'S3': [14, 7, 10, 6, 0, 2, 0, 3, 2], 'S4': [11, 4, 2, 30, 0, 2, 3, 3, 4]},
            "oee": {'sub_assembly': (76.5, 71.8, 50.0, 27.5), 'block_assembly': (83.9, 80.0, 25.0, 16.8), 'grand_assembly': (100.0, 61.5, 50.0, 30.8), 'erection': (54.1, 72.0, 0.0, 0.0)},
        },
        "managed": {
            "delivered": [24, 32, 40, 47], "late": [0, 0, 0, 0], "fpy": (15, 16), "on_time": 4,
            "accidents": 0, "breakdowns": 2, "man_days": 146,
            "costs": {'labor': 3780.0, 'overtime': 0.0, 'maintenance': 400, 'material': 2040.0, 'holding': 0.0, 'wip': 890.0, 'rework': 200.0, 'accident': 0.0, 'breakdown': 300.0, 'transporter': 700, 'investment': 0.0, 'research': 0, 'late_penalty': 0.0},
            "total": 8310.0, "profit": 2890.0,
            "spans": {'S1': [(3, 6), (8, 15), (17, 20), (21, 24)], 'S2': [(11, 13), (18, 23), (25, 27), (28, 32)], 'S3': [(17, 20), (24, 31), (33, 36), (37, 40)], 'S4': [(23, 25), (32, 37), (39, 40), (41, 47)]},
            "parts": {'S1': [20, 0, 0, 0, 0, 2, 0, 0, 0], 'S2': [16, 1, 0, 1, 0, 2, 0, 0, 2], 'S3': [20, 0, 0, 2, 0, 2, 0, 0, 0], 'S4': [16, 0, 0, 5, 0, 2, 0, 0, 2]},
            "oee": {'sub_assembly': (100.0, 53.3, 100.0, 53.3), 'block_assembly': (93.3, 53.3, 100.0, 49.8), 'grand_assembly': (100.0, 53.3, 75.0, 40.0), 'erection': (90.0, 53.3, 100.0, 48.0)},
        },
        "all_in": {
            "delivered": [23, 30, 40, 47], "late": [0, 0, 0, 0], "fpy": (9, 16), "on_time": 4,
            "accidents": 2, "breakdowns": 2, "man_days": 128,
            "costs": {'labor': 5030.0, 'overtime': 640.0, 'maintenance': 400, 'material': 2040.0, 'holding': 240.2, 'wip': 1100.0, 'rework': 1400.0, 'accident': 600.0, 'breakdown': 300.0, 'transporter': 700, 'investment': 0.0, 'research': 0, 'late_penalty': 0.0},
            "total": 12450.2, "profit": -1250.2,
            "spans": {'S1': [(3, 5), (7, 14), (16, 18), (19, 23)], 'S2': [(6, 7), (17, 23), (25, 27), (28, 30)], 'S3': [(8, 12), (24, 28), (30, 32), (33, 40)], 'S4': [(13, 14), (29, 34), (36, 37), (41, 47)]},
            "parts": {'S1': [14, 5, 2, 0, 0, 2, 0, 0, 0], 'S2': [11, 1, 2, 9, 0, 2, 0, 3, 2], 'S3': [14, 4, 2, 10, 0, 2, 0, 6, 2], 'S4': [11, 4, 2, 21, 0, 2, 2, 3, 2]},
            "oee": {'sub_assembly': (85.7, 71.1, 75.0, 45.7), 'block_assembly': (82.1, 81.2, 50.0, 33.3), 'grand_assembly': (100.0, 63.0, 75.0, 47.3), 'erection': (78.3, 72.6, 25.0, 14.2)},
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
            got = [(ship["spans"][p]["start"], ship["spans"][p]["end"]) for p in STATIONS]
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
            return [(e["day"], e["type"], e.get("station") or e.get("transporter"))
                    for e in simulate(PRESETS[pid])["events"] if e["type"] in ("accident", "breakdown")]
        self.assertEqual(stops("unmanaged"), [(10, 'breakdown', 'sub_assembly'), (14, 'breakdown', 'block_assembly'), (16, 'breakdown', 'T2'), (18, 'accident', 'block_assembly'), (32, 'breakdown', 'T1'), (44, 'accident', 'erection'), (53, 'breakdown', 'erection')])
        self.assertEqual(stops("managed"), [(15, 'breakdown', 'block_assembly'), (43, 'breakdown', 'erection')])
        self.assertEqual(stops("all_in"), [(14, 'breakdown', 'block_assembly'), (18, 'accident', 'block_assembly'), (34, 'accident', 'erection'), (43, 'breakdown', 'erection')])


def variant(preset_id, pool, transporters=1, maintained=True, research=(), method=None, maintenance=None):
    cfg = copy.deepcopy(PRESETS[preset_id])
    cfg["pool"] = pool
    cfg["transporters"] = {"count": transporters, "maintenance": maintained}
    cfg["research"] = list(research)
    for st in cfg["stations"].values():
        if method is not None:
            st["method"] = method
        if maintenance is not None:
            st["maintenance"] = maintenance
    return cfg


def crew(preset_id, **crews):
    """프리셋의 공정 인력을 바꾼 설정(2.0 4M). crew("managed", erection="normal")"""
    cfg = copy.deepcopy(PRESETS[preset_id])
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
    cfg = copy.deepcopy(PRESETS[preset_id])
    for pid in stations:
        cfg["stations"][pid]["method"] = name
    return cfg


class GradeTable(unittest.TestCase):
    """10장의 등급 표: (설정, 이익, 납기 준수 척수, 점수, 등급). 4.0 물류 전담 뒤의 "조율 전 값"(D40).
    트랜스포터는 역할마다 한 대로 고정돼(D39) 대수를 바꾼 줄은 뺐다."""

    ROWS = [
        ("무관리", PRESETS["unmanaged"], -3296.0, 2, 43.5, "F"),
        ("전부 최대 투입", PRESETS["all_in"], -1250.2, 4, 56.2, "C"),
        ("관리", PRESETS["managed"], 2890.0, 4, 87.5, "A"),
        ("관리, 4명", variant("managed", 4), 4030.0, 4, 98.4, "A"),
        ("관리, 3명", variant("managed", 3), 1078.0, 2, 53.3, "C"),
        ("관리 + 공정 자동화, 2명", variant("managed", 2, research=["automation"]), 4800.0, 4, 105.7, "S"),
        ("속성 + 자동 검사 → 자동화", variant("managed", 2, research=["auto_inspect", "automation"], method="fast"), 4015.0, 4, 95.9, "A"),
        ("정비 생략 + 예지 정비 → 자동화, 트랜스포터 미정비", variant("managed", 2, 1, False, ["predictive", "automation"], maintenance=False), 3428.0, 2, 80.3, "B"),
        ("관리, 탑재 숙련공 → 일반", crew("managed", erection="normal"), 2850.0, 4, 86.9, "A"),
        ("관리, 중조립 로봇", crew("managed", block_assembly="robot"), 1960.0, 4, 78.4, "B"),
        ("관리, 휴지·저가 물감·저가 깃발", mats("managed", paper="cheap", paint="cheap", flag="cheap"), 2980.0, 4, 86.0, "A"),
        ("관리, 전 공정 신공법", method("managed", "new", *STATIONS), 1690.0, 3, 70.1, "B"),
    ]

    def test_rows(self):
        for name, cfg, profit, on_time, score, grade in self.ROWS:
            with self.subTest(name):
                r = open_sim(cfg)
                self.assertAlmostEqual(r["profit"], profit, places=2)
                self.assertEqual(r["qcd"]["delivery"]["on_time"], on_time)
                self.assertEqual((r["grade"]["score"], r["grade"]["grade"]), (score, grade))

    def test_baseline_line(self):
        g = open_sim(variant("managed", 2, research=["automation"]))["grade"]
        self.assertEqual(g["baseline"]["name"], "전부 최대 투입")
        self.assertEqual((g["baseline"]["score"], g["baseline"]["grade"]), (56.2, "C"))
        self.assertEqual(g["vs_baseline"], {'profit': 6050.2, 'pool': -6, 'score': 49.5})

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
        r = simulate(variant("unmanaged", 8, research=["predictive"]))
        self.assertTrue(all(e["day"] <= 8 for e in r["events"] if e["type"] == "breakdown"))


class Ordering(unittest.TestCase):
    """발주 방식: bulk(1일에 전부), jit(필요일 − 리드타임 − 여유 0일), late(필요일에).
    필요일은 그 자재를 출고하는 날이다. 4.0부터는 T1이 키트를 싣는 날(앞 공정에 들어간 다음 날, 소조립은 착수일)."""

    def order_days(self, preset_id, ordering=None):
        cfg = copy.deepcopy(PRESETS[preset_id])
        if ordering:
            cfg["ordering"] = ordering
        return {s["id"]: s["order_days"] for s in simulate(cfg, baseline=False)["ships"]}

    def test_bulk_orders_everything_on_day_1(self):
        self.assertEqual(self.order_days("all_in"), {sid: {"paper": 1, "paint": 1, "flag": 1} for sid in PRESETS["all_in"]["ships"]})

    def test_jit_counts_back_from_the_day_of_need(self):
        self.assertEqual(self.order_days("managed")["S1"], {"paper": 1, "paint": 4, "flag": 8})
        # 여유 0일이어도 입고가 하루 순서의 맨 앞이라 자재 대기가 없다.
        r = simulate(PRESETS["managed"])
        self.assertEqual(sum(s["lead_time_parts"]["material_wait"] for s in r["ships"]), 0)
        self.assertEqual(self.order_days("managed"), suggest_order_days(PRESETS["managed"], buffer_days=0))

    def test_late_orders_on_the_day_of_need(self):
        self.assertEqual(self.order_days("unmanaged")["S1"], {"paper": 1, "paint": 6, "flag": 15})
        # S1 소조립: 1일에 발주한 종이가 3일에 들어와 리드타임 2일이 그대로 자재 대기가 된다.
        s1 = simulate(PRESETS["unmanaged"])["ships"][0]
        self.assertEqual(segments(s1, "sub_assembly")[0], ("material_wait", 1, 2))
        self.assertEqual(s1["arrival_days"]["flag"], 25)

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
        for tr in r["transporters"]:
            self.assertEqual(len(tr["daily"]), r["days"])
        self.assertEqual(len(r["inventory_daily"]), r["days"])
        self.assertEqual(len(r["workforce"]["daily"]), r["days"])

    def test_inventory_value_is_the_base_of_holding_cost(self):
        r = simulate(PRESETS["all_in"])
        self.assertEqual(len(r["inventory_value_daily"]), r["days"])
        self.assertAlmostEqual(sum(r["inventory_value_daily"]) * 0.01, r["costs"]["holding"], places=2)

    def test_assigned_workers_never_exceed_pool(self):
        for cfg in PRESETS.values():
            r = simulate(cfg)
            for day in range(r["days"]):
                on_stations = sum(u["daily"][day]["workers"] for st in r["stations"] for u in st["units"])
                self.assertEqual(on_stations, r["workforce"]["daily"][day]["assigned"])
                self.assertLessEqual(on_stations, cfg["pool"])

    def test_findings_are_loss_segments_longest_first(self):
        f = simulate(PRESETS["managed"])["findings"]
        self.assertEqual(f[0], {"kind": "station_wait", "ship": "S4", "station": "block_assembly",
                                "start": 27, "end": 31, "days": 5})
        self.assertEqual([x["days"] for x in f], sorted((x["days"] for x in f), reverse=True))

    def test_preview(self):
        p = preview(variant("managed", 6, research=["auto_inspect"]))
        # 탑재는 숙련공(불량률 −8%p), 자동 검사 −5%p. 숙련공 할증은 일한 날마다 붙어 고정비에 없다.
        self.assertEqual(p["stations"]["erection"], {"rate": 2.0, "defect_rate": 0.02, "defect_rate_final": 0.0})
        self.assertEqual(p["fixed_costs"],
                         {"labor": 3600, "maintenance": 400, "transporter": 700, "investment": 0, "research": 300})
        self.assertEqual([(x["id"], x["end"]) for x in p["research"]], [("auto_inspect", 8)])
        # 깃발 필요일 = T1이 탑재 키트를 싣는 날(PE장에 들어간 다음 날, 18일). JIT는 리드타임 10일 앞인 8일에 발주.
        self.assertEqual(p["materials"]["S1"]["flag"], {"order_day": 8, "arrival_day": 18})

    def test_plan_bars_match_the_run_when_nothing_gets_in_the_way(self):
        # 관리 프리셋 S1은 막힘 없이 지나가므로 계획 막대가 실제 구간과 같다.
        plan = preview(PRESETS["managed"])["plan"]
        run = simulate(PRESETS["managed"], baseline=False)
        self.assertEqual(plan["ships"]["S1"], run["ships"][0]["spans"])
        # S1 중조립(8~15일)과 S2 중조립(15~20일)이 15일에 겹친다.
        self.assertIn({"station": "block_assembly", "ships": ["S1", "S2"], "start": 15, "end": 15}, plan["conflicts"])

    def test_invalid_config_is_rejected(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["pool"] = 13   # 3.0 상한 12명(D30)
        cfg["ships"]["S2"]["priority"] = 1
        cfg["research"] = ["automation", "automation"]
        with self.assertRaises(ConfigError) as ctx:
            simulate(cfg)
        self.assertEqual(len(ctx.exception.messages), 3)



def expanded(preset, **units):
    """프리셋에 공정별 작업장 수를 더한 설정. expanded("all_in", block_assembly=2)"""
    cfg = copy.deepcopy(PRESETS[preset])
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
        self.assertEqual(p["fixed_costs"]["maintenance"], 6 * 100)

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
        self.assertEqual(r["costs"]["labor"], 6 * 10 * 60 + worked * 5)

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
        self.assertEqual(cheap["costs"]["material"], 2040 / 2)
        st = next(s for s in cheap["stations"] if s["id"] == "sub_assembly")
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
                         [("basic", "기본 분기", 4), ("growth", "수주 증가", 6), ("surge", "수주 급증", 8)])

    def test_config_without_scenario_runs_as_basic(self):
        # 하위 호환: 1.x 설정(scenario 없음)은 기본 분기로 돈다.
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["scenario"] = "basic"
        self.assertEqual(simulate(cfg)["profit"], simulate(PRESETS["managed"])["profit"])

    def test_growth_presets(self):
        # 조율 전 값(D40)
        cases = {"unmanaged": (-9794.0, 26.8, "F"), "managed": (7118.4, 94.3, "A"), "all_in": (1958.8, 66.4, "C")}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(GROWTH[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)
            self.assertEqual(r["grade"]["baseline"]["score"], 66.4)

    def test_growth_has_lng(self):
        sc = load_scenario("growth")
        self.assertEqual([o["type"] for o in sc["orders"]], ["VLCC", "CONT", "VLCC", "CONT", "LNG", "LNG"])
        self.assertEqual(sc["ship_types"]["LNG"]["work"]["erection"], 18)
        self.assertEqual(sc["kpi"]["revenue"], 20200)

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
        cfg = {**PRESETS["managed"], "pool": 4}
        plain = open_sim(as_areas(cfg), baseline=False)
        split = open_sim(as_areas(cfg, block_assembly={"split": True}), baseline=False)
        self.assertEqual(split["profit"], plain["profit"])

    def test_split_divides_work_and_waits_for_the_pair(self):
        # 1차 시험 결과: 관리안 인원 4명에 중조립 2곳 나눠 하기 → 지연 없음. 점수는 조율 전 값(D40).
        cfg = as_areas({**PRESETS["managed"], "pool": 4}, block_assembly={"stations": 2, "split": True})
        r = open_sim(cfg)
        self.assertEqual((r["grade"]["grade"], r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), ("A", 95.4, 4))
        # 들어갈 때 빈 작업장 수만큼 나눈다. 4.0에서는 네 척 모두 두 곳이 비어 있을 때 들어간다
        # (3.x에서는 한 척이 다른 배가 2호를 쓰는 중이라 1곳이었다. 1곳만 비면 나누지 않는 경우는 손 계산 예시 4).
        # 투입 기록은 배마다 하나(나눠 들어가면 units에 작업장 목록). 검사는 배 한 척에 한 번이다.
        enters = [e for e in r["events"] if e["type"] == "enter" and e["station"] == "block_assembly"]
        self.assertEqual([e.get("units") for e in enters].count([1, 2]), 4)
        self.assertEqual(len(enters), 4)
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual(block["inspections"], 4)
        parts = [d["parts"] for s in r["ships"] for d in s["daily"] if "parts" in d]
        self.assertTrue(parts and all(len(p) == 2 for p in parts))

    def test_expanding_without_split_does_not_fix_the_delay(self):
        # 조율 전(D40): 4.0 물류 전담 뒤에는 관리안 4명도 지연이 없어 이 비교의 전제(한 척 지연)가 사라졌다.
        # 값만 적어 두고, 다음 조율(버전을 올릴 때) 지연이 생기는 설정으로 다시 잡는다.
        cfg = as_areas({**PRESETS["managed"], "pool": 4}, block_assembly={"stations": 2})
        r = open_sim(cfg)
        self.assertEqual((r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), (95.0, 4))

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
        # 조율 전 값(D40). 블록 운반이 한 대로 줄어 관리안도 한 척 지연(7/8)
        cases = {"unmanaged": (-14055.0, 22.5, "F"), "managed": (10439.4, 95.5, "A"), "all_in": (1854.6, 63.3, "C")}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(SURGE[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)

    def test_split_is_what_saves_the_schedule(self):
        # 관리안에서 나눠 하기만 끄면 납기를 놓친다.
        off = copy.deepcopy(SURGE["managed"])
        off["stations"]["block_assembly"]["split"] = False
        on = simulate(SURGE["managed"], baseline=False)
        self.assertGreater(on["qcd"]["delivery"]["on_time"], simulate(off, baseline=False)["qcd"]["delivery"]["on_time"])



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

    def test_presets_never_borrow(self):
        # 발주 방식(일괄, JIT, 늦은 발주)은 배마다 자기 필요일에 맞춰 발주해서 남의 몫을 빌릴 일이 없다.
        for sid in ("basic", "growth", "surge"):
            for preset in load_presets(sid):
                r = simulate(preset["config"], baseline=False)
                for ev in (e for e in r["events"] if e["type"] == "issue"):
                    self.assertEqual(ev["from"], [{"ship": ev["ship"], "quantity": ev["quantity"]}])

    def test_own_first_then_borrow_oldest(self):
        # 배별 발주일(1.0 방식): S3 종이를 1일에(3일 입고), S1 종이를 3일에(5일 입고) 발주한다.
        # 3일에 S1은 자기 몫이 없어 S3 몫을 빌리고, 17일에 S3은 S1 몫을 빌린다. 11일의 S2는 S1 몫이 선반에 있어도 자기 몫을 쓴다.
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
        self.assertEqual((issues["S2"]["day"], issues["S2"]["from"]), (11, [{"ship": "S2", "quantity": 6}]))
        self.assertEqual((issues["S3"]["day"], issues["S3"]["from"]), (17, [{"ship": "S1", "quantity": 8}]))
        self.assertEqual(r["pegging_daily"][9]["paper"], [{"ship": "S1", "quantity": 8}])   # 10일 끝: S1 몫 8장이 선반에
        # 일정은 관리 프리셋과 같고, S3 종이가 14일 일찍 들어와 재고비만 19.2 늘었다(이익은 조율 전 값).
        self.assertEqual([s["daily"] for s in r["ships"]], [s["daily"] for s in simulate(base, baseline=False)["ships"]])
        self.assertEqual((r["costs"]["holding"], r["profit"]), (19.2, 2870.8))

    def test_take_order(self):
        # 자기 몫 → 공용(처음 재고) → 남의 몫(먼저 들어온 것부터)
        batches = [[0, None, 2], [1, "S2", 3], [2, "S3", 3], [4, "S1", 1]]
        self.assertEqual(_take_pegged(batches, "S1", 6),
                         [{"ship": "S1", "quantity": 1}, {"ship": None, "quantity": 2}, {"ship": "S2", "quantity": 3}])
        self.assertEqual(batches, [[2, "S3", 3]])


if __name__ == "__main__":
    unittest.main()
