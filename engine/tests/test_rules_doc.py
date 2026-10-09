"""규칙 문서 10장 "검증용 예시"의 값을 그대로 확인한다.

    python -m unittest discover -s engine/tests -t engine     (또는 pytest engine)

여기서 하나라도 깨지면 엔진이 규칙 문서와 달라진 것이다.
"""

import copy
import unittest

from shipyard import ConfigError, list_scenarios, load_presets, load_scenario, preview, simulate, suggest_order_days

PRESETS = {p["id"]: p["config"] for p in load_presets()}
STATIONS = ["sub_assembly", "block_assembly", "grand_assembly", "erection"]
STATES = ["work", "rework", "material_wait", "station_wait", "labor_wait",
          "transport", "transport_wait", "accident_stop", "breakdown_stop"]


def one_ship_scenario(stock, quality=0.99):
    """손 계산 예시용: S1 한 척, 초기 재고 지정, 불량 없음(난수 0.99)."""
    sc = load_scenario()
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
        # 처리량 2/일. 운반은 끝난 다음 날부터 6씩 이틀, 다 나른 둘째 날 바로 다음 공정에 들어간다.
        self.assertEqual(spans(r, "S1"), {"sub_assembly": (1, 4), "block_assembly": (6, 13),
                                          "grand_assembly": (15, 18), "erection": (20, 23)})
        self.assertEqual(segments(r["ships"][0]), [
            ("work", 1, 4), ("transport", 5, 5), ("work", 6, 13), ("transport", 14, 14),
            ("work", 15, 18), ("transport", 19, 19), ("work", 20, 23)])
        self.assertEqual(r["ships"][0]["delivered_day"], 23)
        self.assertEqual(r["costs"]["wip"], 220)
        # 중조립은 13일에 일한 날이 8일째라 고장 판정: 난수 0.05 < 정비 기준 0.1 → 고장. 배는 이미 끝나 손실은 없다.
        self.assertEqual([(e["day"], e["station"]) for e in r["events"] if e["type"] == "breakdown"],
                         [(13, "block_assembly")])
        self.assertEqual(r["costs"]["breakdown"], 150)
        self.assertEqual(r["costs"]["transporter"], 350)

    def test_example_4_split(self):
        # 3.0 손 계산 예시 4: 예시 1에서 중조립만 작업장 2곳 + 나눠 하기, 대기소 4명.
        cfg = one_ship_config()
        cfg["pool"] = 4
        cfg["stations"]["block_assembly"].update({"units": 2, "split": True})
        r = simulate(cfg, one_ship_scenario(FULL))
        # 중조립 16을 2곳에 8씩, 곳마다 2명 → 4일(6~9일). 인도는 예시 1(23일)보다 4일 빠른 19일.
        self.assertEqual(spans(r, "S1"), {"sub_assembly": (1, 4), "block_assembly": (6, 9),
                                          "grand_assembly": (11, 14), "erection": (16, 19)})
        self.assertEqual(r["ships"][0]["delivered_day"], 19)
        self.assertEqual((r["costs"]["wip"], r["costs"]["labor"], r["costs"]["investment"], r["costs"]["maintenance"]),
                         (180, 2400, 300, 500))
        # 대기소가 2명이면 2호는 1호가 끝날 때까지 인력 대기, 그 뒤 1호가 짝 대기 → 나누지 않은 것과 같은 6~13일.
        cfg["pool"] = 2
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual(spans(r, "S1")["block_assembly"], (6, 13))
        parts = [[p["state"] for p in d["parts"]] for d in r["ships"][0]["daily"][5:13]]
        self.assertEqual(parts, [["work", "labor_wait"]] * 4 + [["pair_wait", "work"]] * 4)
        # 3곳 + 6명이면 부분 5.33, 3일(6~8일), 인도 18일.
        cfg["pool"] = 6
        cfg["stations"]["block_assembly"]["units"] = 3
        r = simulate(cfg, one_ship_scenario(FULL))
        self.assertEqual((spans(r, "S1")["block_assembly"], r["ships"][0]["delivered_day"]), ((6, 8), 18))

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
        self.assertEqual(r["ships"][0]["delivered_day"], 23)
        self.assertEqual(r["costs"]["rework"], 200)
        self.assertEqual(r["costs"]["overtime"], 80)
        self.assertEqual(r["costs"]["maintenance"], base["costs"]["maintenance"] - 100)
        self.assertEqual(r["total_cost"] - base["total_cost"], 180)

    def test_example_3_late_order(self):
        r = simulate(one_ship_config({"flag": 18}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        ship = r["ships"][0]
        self.assertEqual(spans(r, "S1")["erection"], (28, 31))
        self.assertEqual(ship["lead_time_parts"]["material_wait"], 8)
        self.assertEqual((ship["delivered_day"], ship["late_days"]), (31, 1))
        self.assertEqual(r["costs"]["late_penalty"], 90)
        self.assertEqual(r["costs"]["wip"], 300)

    def test_example_3_early_order(self):
        with_flag = simulate(one_ship_config({"flag": 1}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        self.assertEqual(with_flag["ships"][0]["delivered_day"], 23)
        # 깃발 200어치를 11~19일 9일 동안 보관: 200 × 1% × 9 = 18.
        # 기준 실행은 깃발을 1~19일 19일 동안 들고 있으므로 차이는 10일분 20이다.
        self.assertAlmostEqual(base["costs"]["holding"] - with_flag["costs"]["holding"], 20)


class Presets(unittest.TestCase):
    """10장의 프리셋 3개 기대 결과."""

    EXPECTED = {
        "unmanaged": {
            "delivered": [34, 53, 45, 60], "late": [4, 15, 0, 4], "fpy": (5, 16), "on_time": 1,
            "accidents": 2, "breakdowns": 6, "man_days": 144,
            "costs": {'labor': 4800, 'overtime': 720, 'maintenance': 0, 'material': 2040, 'holding': 0, 'wip': 1540, 'rework': 2200, 'accident': 600, 'breakdown': 900, 'transporter': 300, 'investment': 0, 'research': 0, 'late_penalty': 1842},
            "total": 14942.0, "profit": -3742.0,
            "spans": {'S1': [(3, 5), (7, 14), (19, 23), (30, 34)], 'S2': [(13, 15), (28, 31), (38, 40), (49, 53)], 'S3': [(6, 10), (17, 27), (32, 34), (41, 45)], 'S4': [(16, 17), (32, 37), (44, 45), (54, 60)]},
            "parts": {'S1': [14, 7, 10, 0, 0, 3, 0, 0, 0], 'S2': [11, 4, 5, 20, 0, 3, 3, 5, 2], 'S3': [14, 7, 10, 6, 0, 3, 0, 3, 2], 'S4': [11, 4, 5, 27, 0, 3, 4, 2, 4]},
            "oee": {'sub_assembly': (76.5, 71.8, 50.0, 27.5), 'block_assembly': (83.9, 80.0, 25.0, 16.8), 'grand_assembly': (52.0, 61.5, 50.0, 16.0), 'erection': (57.1, 72.0, 0.0, 0.0)},
        },
        "managed": {
            "delivered": [25, 33, 43, 51], "late": [0, 0, 0, 0], "fpy": (15, 16), "on_time": 4,
            "accidents": 0, "breakdowns": 2, "man_days": 146,
            "costs": {'labor': 3780, 'overtime': 0, 'maintenance': 400, 'material': 2040, 'holding': 0, 'wip': 980, 'rework': 200, 'accident': 0, 'breakdown': 300, 'transporter': 350, 'investment': 0, 'research': 0, 'late_penalty': 0},
            "total": 8050.0, "profit": 3150.0,
            "spans": {'S1': [(3, 6), (8, 15), (17, 20), (22, 25)], 'S2': [(11, 13), (18, 23), (25, 27), (29, 33)], 'S3': [(17, 20), (26, 33), (35, 38), (40, 43)], 'S4': [(23, 25), (34, 39), (42, 43), (45, 51)]},
            "parts": {'S1': [20, 0, 0, 0, 0, 3, 0, 0, 0], 'S2': [16, 1, 0, 1, 0, 3, 0, 0, 2], 'S3': [20, 0, 0, 0, 0, 3, 4, 0, 0], 'S4': [16, 0, 0, 4, 0, 3, 4, 0, 2]},
            "oee": {'sub_assembly': (100.0, 53.3, 100.0, 53.3), 'block_assembly': (93.3, 53.3, 100.0, 49.8), 'grand_assembly': (100.0, 53.3, 75.0, 40.0), 'erection': (90.0, 53.3, 100.0, 48.0)},
        },
        "all_in": {
            "delivered": [24, 31, 42, 49], "late": [0, 0, 0, 0], "fpy": (9, 16), "on_time": 4,
            "accidents": 2, "breakdowns": 2, "man_days": 128,
            "costs": {'labor': 5030, 'overtime': 640, 'maintenance': 400, 'material': 2040, 'holding': 335.6, 'wip': 1160, 'rework': 1400, 'accident': 600, 'breakdown': 300, 'transporter': 350, 'investment': 0, 'research': 0, 'late_penalty': 0},
            "total": 12255.6, "profit": -1055.6,
            "spans": {'S1': [(3, 5), (7, 14), (16, 18), (20, 24)], 'S2': [(6, 7), (17, 23), (25, 27), (29, 31)], 'S3': [(8, 12), (24, 28), (31, 33), (35, 42)], 'S4': [(13, 14), (29, 34), (37, 38), (43, 49)]},
            "parts": {'S1': [14, 5, 2, 0, 0, 3, 0, 0, 0], 'S2': [11, 1, 2, 9, 0, 3, 0, 3, 2], 'S3': [14, 4, 2, 10, 0, 3, 1, 6, 2], 'S4': [11, 4, 2, 21, 0, 3, 3, 3, 2]},
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
        self.assertEqual(stops("unmanaged"), [
            (10, "breakdown", "sub_assembly"), (14, "breakdown", "block_assembly"), (16, "breakdown", "T1"),
            (18, "accident", "block_assembly"), (36, "breakdown", "T1"), (45, "accident", "erection"),
            (47, "breakdown", "T1"), (54, "breakdown", "erection")])
        self.assertEqual(stops("managed"), [(15, "breakdown", "block_assembly"), (47, "breakdown", "erection")])
        self.assertEqual(stops("all_in"), [
            (14, "breakdown", "block_assembly"), (18, "accident", "block_assembly"),
            (36, "accident", "erection"), (45, "breakdown", "erection")])


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
    """10장의 등급 표: (설정, 이익, 납기 준수 척수, 점수, 등급)."""

    ROWS = [
        ("무관리", PRESETS["unmanaged"], -3742.0, 1, 38.5, "F"),
        ("전부 최대 투입", PRESETS["all_in"], -1055.6, 4, 56.2, "C"),
        ("관리", PRESETS["managed"], 3150.0, 4, 90.0, "A"),
        ("관리, 트랜스포터 2대", variant("managed", 6, 2), 2970.0, 4, 88.3, "A"),
        ("관리, 4명", variant("managed", 4), 4220.0, 3, 95.2, "A"),
        ("관리, 3명", variant("managed", 3), 1468.0, 2, 57.0, "C"),
        ("관리 + 공정 자동화, 2명", variant("managed", 2, research=["automation"]), 5120.0, 4, 108.8, "S"),
        ("관리 + 공정 자동화, 2명, 2대", variant("managed", 2, 2, research=["automation"]), 4920.0, 4, 106.9, "S"),
        ("속성 + 자동 검사 → 자동화", variant("managed", 2, research=["auto_inspect", "automation"], method="fast"), 4320.0, 4, 98.8, "A"),
        ("정비 생략 + 예지 정비 → 자동화, 1대 미정비", variant("managed", 2, 1, False, ["predictive", "automation"], maintenance=False), 740.0, 0, 37.5, "F"),
        ("정비 생략 + 예지 정비 → 자동화, 2대 미정비", variant("managed", 2, 2, False, ["predictive", "automation"], maintenance=False), 3844.0, 2, 84.2, "B"),
        ("관리, 탑재 숙련공 → 일반", crew("managed", erection="normal"), 3110.0, 4, 89.3, "A"),
        ("관리, 중조립 로봇", crew("managed", block_assembly="robot"), 2230.0, 4, 81.0, "B"),
        ("관리, 휴지·저가 물감·저가 깃발", mats("managed", paper="cheap", paint="cheap", flag="cheap"), 3280.0, 4, 88.9, "A"),
        ("관리, 전 공정 신공법", method("managed", "new", *STATIONS), 1890.0, 3, 72.0, "B"),
    ]

    def test_rows(self):
        for name, cfg, profit, on_time, score, grade in self.ROWS:
            with self.subTest(name):
                r = simulate(cfg)
                self.assertAlmostEqual(r["profit"], profit, places=2)
                self.assertEqual(r["qcd"]["delivery"]["on_time"], on_time)
                self.assertEqual((r["grade"]["score"], r["grade"]["grade"]), (score, grade))

    def test_baseline_line(self):
        g = simulate(variant("managed", 2, research=["automation"]))["grade"]
        self.assertEqual(g["baseline"]["name"], "전부 최대 투입")
        self.assertEqual((g["baseline"]["score"], g["baseline"]["grade"]), (56.2, "C"))
        self.assertEqual(g["vs_baseline"], {"profit": 6175.6, "pool": -6, "score": 52.6})

    def test_parts_add_up(self):
        g = simulate(PRESETS["managed"])["grade"]
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
    """발주 방식: bulk(1일에 전부), jit(필요일 − 리드타임 − 여유 0일), late(필요일에)."""

    def order_days(self, preset_id, ordering=None):
        cfg = copy.deepcopy(PRESETS[preset_id])
        if ordering:
            cfg["ordering"] = ordering
        return {s["id"]: s["order_days"] for s in simulate(cfg, baseline=False)["ships"]}

    def test_bulk_orders_everything_on_day_1(self):
        self.assertEqual(self.order_days("all_in"), {sid: {"paper": 1, "paint": 1, "flag": 1} for sid in PRESETS["all_in"]["ships"]})

    def test_jit_counts_back_from_the_day_of_need(self):
        self.assertEqual(self.order_days("managed")["S1"], {"paper": 1, "paint": 12, "flag": 12})
        # 여유 0일이어도 입고가 하루 순서의 맨 앞이라 자재 대기가 없다.
        r = simulate(PRESETS["managed"])
        self.assertEqual(sum(s["lead_time_parts"]["material_wait"] for s in r["ships"]), 0)
        self.assertEqual(self.order_days("managed"), suggest_order_days(PRESETS["managed"], buffer_days=0))

    def test_late_orders_on_the_day_of_need(self):
        self.assertEqual(self.order_days("unmanaged")["S1"], {"paper": 1, "paint": 14, "flag": 20})
        # S1 소조립: 1일에 발주한 종이가 3일에 들어와 리드타임 2일이 그대로 자재 대기가 된다.
        s1 = simulate(PRESETS["unmanaged"])["ships"][0]
        self.assertEqual(segments(s1, "sub_assembly")[0], ("material_wait", 1, 2))
        self.assertEqual(s1["arrival_days"]["flag"], 30)

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
                                "start": 30, "end": 33, "days": 4})
        self.assertEqual([x["days"] for x in f], sorted((x["days"] for x in f), reverse=True))

    def test_preview(self):
        p = preview(variant("managed", 6, research=["auto_inspect"]))
        # 탑재는 숙련공(불량률 −8%p), 자동 검사 −5%p. 숙련공 할증은 일한 날마다 붙어 고정비에 없다.
        self.assertEqual(p["stations"]["erection"], {"rate": 2.0, "defect_rate": 0.02, "defect_rate_final": 0.0})
        self.assertEqual(p["fixed_costs"],
                         {"labor": 3600, "maintenance": 400, "transporter": 350, "investment": 0, "research": 300})
        self.assertEqual([(x["id"], x["end"]) for x in p["research"]], [("auto_inspect", 8)])
        self.assertEqual(p["materials"]["S1"]["flag"], {"order_day": 12, "arrival_day": 22})

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
            self.assertEqual(simulate(expanded(pid, **{s: 1 for s in STATIONS})), simulate(PRESETS[pid]))

    def test_two_units_work_on_two_ships_at_once(self):
        r = simulate(expanded("all_in", block_assembly=2), baseline=False)
        block = next(st for st in r["stations"] if st["id"] == "block_assembly")
        self.assertEqual([u["unit"] for u in block["units"]], [1, 2])
        both = [d for d in range(r["days"]) if all(u["daily"][d]["ship"] for u in block["units"])]
        self.assertTrue(both)
        ships = {u["daily"][both[0]]["ship"] for u in block["units"]}
        self.assertEqual(len(ships), 2)

    def test_expansion_cuts_station_wait_at_that_station(self):
        def waits(cfg):
            r = simulate(cfg, baseline=False)
            return sum(1 for s in r["ships"] for d in s["daily"]
                       if d["state"] == "station_wait" and d["station"] == "block_assembly")
        self.assertLess(waits(expanded("all_in", block_assembly=2)), waits(PRESETS["all_in"]))

    def test_expansion_cost_and_maintenance_per_unit(self):
        p = preview(expanded("all_in", block_assembly=2, erection=2))
        self.assertEqual(p["fixed_costs"]["investment"], 300 + 800)
        self.assertEqual(p["fixed_costs"]["maintenance"], 6 * 100)

    def test_plan_overlap_only_when_more_ships_than_units(self):
        plan = preview(expanded("managed", block_assembly=2))["plan"]
        self.assertFalse([c for c in plan["conflicts"] if c["station"] == "block_assembly"])

    def test_unit_is_recorded_on_ships_and_events(self):
        r = simulate(expanded("all_in", block_assembly=2), baseline=False)
        enters = [e for e in r["events"] if e["type"] == "enter" and e["station"] == "block_assembly"]
        self.assertEqual({e["unit"] for e in enters}, {1, 2})
        on_unit_2 = [d for s in r["ships"] for d in s["daily"] if d.get("unit") == 2]
        self.assertTrue(on_unit_2)

    def test_too_many_units_is_rejected(self):
        # 3.0: 작업장은 공정마다 3개까지(D30)
        with self.assertRaises(ConfigError):
            simulate(expanded("managed", block_assembly=4))



GROWTH = {p["id"]: p["config"] for p in load_presets("growth")}


class FourM(unittest.TestCase):
    """2.0 4M 선택지: 인력(일반·숙련공·로봇), 신공법(학습 곡선), 자재 등급(표준·저가)."""

    def test_skilled_crew_premium_is_per_worker_day(self):
        r = simulate(PRESETS["managed"])
        erection = next(st for st in r["stations"] if st["id"] == "erection")
        worked = sum(d["workers"] for d in erection["daily"])
        self.assertEqual(r["costs"]["labor"], 6 * 10 * 60 + worked * 5)

    def test_robot_needs_nobody_and_costs_install(self):
        r = simulate(crew("managed", block_assembly="robot"), baseline=False)
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
        cheap = simulate(mats("managed", paper="cheap", paint="cheap", flag="cheap"), baseline=False)
        self.assertEqual(cheap["costs"]["material"], 2040 / 2)
        st = next(s for s in cheap["stations"] if s["id"] == "sub_assembly")
        self.assertEqual(st["defect_rate"], 0.10 + 0.30)

    def test_robot_does_no_overtime(self):
        cfg = crew("unmanaged", sub_assembly="robot")
        r = simulate(cfg, baseline=False)
        self.assertFalse([e for e in r["events"] if e["type"] == "accident" and e["station"] == "sub_assembly"])

    def test_old_senior_reads_as_skilled_crew(self):
        # 하위 호환: 1.x 설정의 skilled_station은 그 공정의 숙련공이다.
        old = copy.deepcopy(PRESETS["managed"])
        del old["stations"]["erection"]["crew"]
        old["skilled_station"] = "erection"
        self.assertEqual(simulate(old)["profit"], simulate(PRESETS["managed"])["profit"])


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
        cases = {"unmanaged": (-13158.0, 16.3, "F"), "managed": (7340.8, 95.4, "A"), "all_in": (1856.2, 65.9, "C")}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(GROWTH[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)
            self.assertEqual(r["grade"]["baseline"]["score"], 65.9)

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
    """3.0(규칙 문서 "3.0 설계 초안"): 공정 = 구역, 작업장 1~3개, 공정마다 4M, 나눠 하기."""

    def test_areas_form_gives_the_same_result(self):
        # 하위 호환: 같은 설정을 areas로 적어도 결과가 같다.
        for pid in ("unmanaged", "managed", "all_in"):
            self.assertEqual(simulate(as_areas(PRESETS[pid]))["profit"], simulate(PRESETS[pid])["profit"], pid)
        self.assertEqual(simulate(as_areas(GROWTH["managed"]))["profit"], simulate(GROWTH["managed"])["profit"])

    def test_split_without_extra_station_changes_nothing(self):
        cfg = {**PRESETS["managed"], "pool": 4}
        plain = simulate(as_areas(cfg), baseline=False)
        split = simulate(as_areas(cfg, block_assembly={"split": True}), baseline=False)
        self.assertEqual(split["profit"], plain["profit"])

    def test_split_divides_work_and_waits_for_the_pair(self):
        # 1차 시험 결과: 관리안 인원 4명(한 척 1일 지연)에 중조립 2곳 나눠 하기 → 지연 없음, 98.5점.
        cfg = as_areas({**PRESETS["managed"], "pool": 4}, block_assembly={"stations": 2, "split": True})
        r = simulate(cfg)
        self.assertEqual((r["grade"]["grade"], r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), ("A", 98.5, 4))
        # 들어갈 때 빈 작업장 수만큼 나눈다. 세 척은 2곳(투입 기록 2개), 한 척은 다른 배가 2호를 쓰는 중이라 1곳이다.
        # 검사는 배 한 척에 한 번이다.
        enters = [e for e in r["events"] if e["type"] == "enter" and e["station"] == "block_assembly"]
        self.assertEqual(len(enters), 7)
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual(block["inspections"], 4)
        parts = [d["parts"] for s in r["ships"] for d in s["daily"] if "parts" in d]
        self.assertTrue(parts and all(len(p) == 2 for p in parts))

    def test_expanding_without_split_does_not_fix_the_delay(self):
        cfg = as_areas({**PRESETS["managed"], "pool": 4}, block_assembly={"stations": 2})
        r = simulate(cfg)
        self.assertEqual((r["grade"]["score"], r["qcd"]["delivery"]["on_time"]), (91.6, 3))

    def test_plan_bar_uses_part_work(self):
        # 계획 막대: 나눠 하기를 켠 공정은 작업장을 모두 쓴다고 보고 부분 작업량으로 잰다(S1 중조립 16 ÷ 2곳 ÷ 2/일 = 4일).
        plan = preview(as_areas(PRESETS["managed"], block_assembly={"stations": 2, "split": True}))["plan"]
        span = plan["ships"]["S1"]["block_assembly"]
        self.assertEqual(span["end"] - span["start"] + 1, 4)

    def test_erection_is_never_split(self):
        cfg = as_areas(GROWTH["managed"], erection={"stations": 2, "split": True})
        r = simulate(cfg, baseline=False)
        self.assertFalse([d for s in r["ships"] for d in s["daily"] if "parts" in d and d["station"] == "erection"])

    def test_limits(self):
        cfg = as_areas(PRESETS["managed"], block_assembly={"stations": 3, "split": True})
        cfg["pool"] = 12
        simulate(cfg)   # 3곳, 12명까지는 된다
        cfg["areas"]["block_assembly"]["split"] = "yes"
        with self.assertRaises(ConfigError):
            simulate(cfg)


SURGE = {p["id"]: p["config"] for p in load_presets("surge")}


class Surge(unittest.TestCase):
    """3.0 새 분기 "수주 급증"(8척): 3호 작업장과 나눠 하기의 판단 거리."""

    def test_presets(self):
        cases = {"unmanaged": (-17090.0, 19.4, "F"), "managed": (10712.8, 99.0, "A"), "all_in": (795.2, 54.5, "C")}
        for pid, (profit, score, grade) in cases.items():
            r = simulate(SURGE[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"]), (profit, score, grade), pid)

    def test_split_is_what_saves_the_schedule(self):
        # 관리안에서 나눠 하기만 끄면 납기를 놓친다.
        off = copy.deepcopy(SURGE["managed"])
        off["stations"]["block_assembly"]["split"] = False
        on = simulate(SURGE["managed"], baseline=False)
        self.assertGreater(on["qcd"]["delivery"]["on_time"], simulate(off, baseline=False)["qcd"]["delivery"]["on_time"])


if __name__ == "__main__":
    unittest.main()
