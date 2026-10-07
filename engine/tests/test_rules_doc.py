"""규칙 문서 10장 "검증용 예시"의 값을 그대로 확인한다.

    python -m unittest discover -s engine/tests -t engine     (또는 pytest engine)

여기서 하나라도 깨지면 엔진이 규칙 문서와 달라진 것이다.
"""

import copy
import unittest

from shipyard import ConfigError, load_presets, load_scenario, preview, simulate, suggest_order_days

PRESETS = {p["id"]: p["config"] for p in load_presets()}


def one_ship_scenario(stock, quality=0.99):
    """손 계산 예시용: S1 한 척, 초기 재고 지정, 불량 없음(난수 0.99)."""
    sc = load_scenario()
    sc["orders"] = [o for o in sc["orders"] if o["id"] == "S1"]
    sc["initial_stock"] = stock
    sc["random"]["quality"] = {"S1": {s["id"]: quality for s in sc["stations"]}}
    return sc


def one_ship_config(order_days=None):
    def station(workers):
        return {"workers": workers, "method": "standard", "overtime": False, "maintenance": True}
    return {
        "ships": {"S1": {"priority": 1, "start_day": 1, "order_days": order_days or {}}},
        "stations": {"sub_assembly": station(1), "block_assembly": station(2), "grand_assembly": station(1), "erection": station(2)},
        "skilled_station": None,
    }


def spans(result, ship_id):
    ship = next(s for s in result["ships"] if s["id"] == ship_id)
    return {k: (v["start"], v["end"]) for k, v in ship["spans"].items()}


FULL = {"paper": 8, "paint": 4, "flag": 2}


class HandExamples(unittest.TestCase):
    def test_example_1_schedule(self):
        r = simulate(one_ship_config(), one_ship_scenario(FULL))
        self.assertEqual(spans(r, "S1"), {"sub_assembly": (1, 8), "block_assembly": (9, 16), "grand_assembly": (17, 24), "erection": (25, 28)})
        self.assertEqual(r["ships"][0]["delivered_day"], 28)
        self.assertEqual(r["costs"]["wip"], 270)

    def test_example_2_defect_and_rework(self):
        cfg = one_ship_config()
        cfg["stations"]["block_assembly"] = {"workers": 2, "method": "fast", "overtime": True, "maintenance": False}
        sc = one_ship_scenario(FULL)
        sc["random"]["quality"]["S1"]["block_assembly"] = 0.21
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        r = simulate(cfg, sc)
        block = next(s for s in r["stations"] if s["id"] == "block_assembly")
        self.assertEqual(block["defect_rate"], 0.5)
        self.assertEqual(block["rate"], 3.75)
        segs = [(s["state"], s["start"], s["end"]) for s in r["ships"][0]["segments"] if s["station"] == "block_assembly"]
        self.assertEqual(segs, [("work", 9, 13), ("rework", 14, 16)])
        self.assertEqual(r["ships"][0]["delivered_day"], 28)
        self.assertEqual(r["costs"]["rework"], 200)
        self.assertEqual(r["costs"]["overtime"], 80)
        self.assertEqual(r["costs"]["maintenance"], base["costs"]["maintenance"] - 100)
        self.assertEqual(r["total_cost"] - base["total_cost"], 180)

    def test_example_3_late_order(self):
        r = simulate(one_ship_config({"flag": 18}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        ship = r["ships"][0]
        self.assertEqual(spans(r, "S1")["erection"], (28, 31))
        self.assertEqual(ship["breakdown"]["material_wait"], 3)
        self.assertEqual((ship["delivered_day"], ship["late_days"]), (31, 1))
        self.assertEqual(r["costs"]["late_penalty"], 90)
        self.assertEqual(r["costs"]["wip"], 300)

    def test_example_3_early_order(self):
        with_flag = simulate(one_ship_config({"flag": 1}), one_ship_scenario({"paper": 8, "paint": 4, "flag": 0}))
        base = simulate(one_ship_config(), one_ship_scenario(FULL))
        self.assertEqual(with_flag["ships"][0]["delivered_day"], 28)
        # 깃발 200어치를 11~24일 14일 동안 보관: 200 × 1% × 14 = 28.
        # 기준 실행은 깃발을 1~24일 24일 동안 들고 있으므로 차이는 10일분 20이다.
        self.assertAlmostEqual(base["costs"]["holding"] - with_flag["costs"]["holding"], 20)


class Presets(unittest.TestCase):
    """10장의 프리셋 3개 기대 결과."""

    EXPECTED = {
        "unmanaged": {
            "delivered": [34, 47, 39], "late": [4, 9, 0], "fpy": (3, 12), "on_time": 1, "accidents": 2,
            "costs": {"labor": 4800, "overtime": 570, "maintenance": 0, "material": 1540, "holding": 90.6,
                      "wip": 1000, "rework": 1800, "accident": 600, "late_penalty": 1062},
            "total": 11462.6, "profit": -2862.6,
            "spans": {"S1": [(3, 5), (6, 13), (15, 19), (30, 34)],
                      "S2": [(11, 13), (25, 28), (29, 31), (43, 47)],
                      "S3": [(6, 10), (14, 24), (25, 27), (35, 39)]},
            "breakdown": {"S1": [14, 7, 13, 0, 0], "S2": [11, 4, 2, 24, 6], "S3": [14, 7, 4, 11, 3]},
            "oee": {"sub_assembly": (84.6, 70.3, 33.3, 19.8), "block_assembly": (87.0, 80.0, 33.3, 23.2),
                    "grand_assembly": (91.7, 63.0, 33.3, 19.3), "erection": (53.6, 69.3, 0.0, 0.0)},
        },
        "managed": {
            "delivered": [30, 37, 44], "late": [0, 0, 0], "fpy": (11, 12), "on_time": 3, "accidents": 0,
            "costs": {"labor": 3900, "overtime": 0, "maintenance": 400, "material": 1540, "holding": 13.8,
                      "wip": 800, "rework": 200, "accident": 0, "late_penalty": 0},
            "total": 6853.8, "profit": 1746.2,
            "spans": {"S1": [(3, 10), (11, 18), (19, 26), (27, 30)],
                      "S2": [(11, 16), (19, 24), (27, 32), (33, 37)],
                      "S3": [(17, 24), (25, 32), (33, 40), (41, 44)]},
            "breakdown": {"S1": [28, 0, 0, 0, 0], "S2": [21, 2, 0, 4, 0], "S3": [28, 0, 0, 0, 0]},
            "oee": {"sub_assembly": (100.0, 26.7, 100.0, 26.7), "block_assembly": (100.0, 53.3, 100.0, 53.3),
                    "grand_assembly": (100.0, 26.7, 66.7, 17.8), "erection": (100.0, 53.3, 100.0, 53.3)},
        },
        "all_in": {
            "delivered": [21, 26, 39], "late": [0, 0, 0], "fpy": (6, 12), "on_time": 3, "accidents": 2,
            "costs": {"labor": 5100, "overtime": 520, "maintenance": 400, "material": 1540, "holding": 166.2,
                      "wip": 690, "rework": 1200, "accident": 600, "late_penalty": 0},
            "total": 10216.2, "profit": -1616.2,
            "spans": {"S1": [(3, 5), (6, 13), (14, 16), (17, 21)],
                      "S2": [(6, 7), (14, 20), (21, 23), (24, 26)],
                      "S3": [(8, 12), (21, 28), (29, 31), (32, 39)]},
            "breakdown": {"S1": [14, 5, 2, 0, 0], "S2": [11, 1, 2, 9, 3], "S3": [14, 7, 2, 10, 6]},
            "oee": {"sub_assembly": (83.3, 69.3, 66.7, 38.5), "block_assembly": (87.0, 80.0, 33.3, 23.2),
                    "grand_assembly": (100.0, 65.2, 66.7, 43.5), "erection": (81.2, 69.7, 33.3, 18.9)},
        },
    }
    STATIONS = ["sub_assembly", "block_assembly", "grand_assembly", "erection"]
    STATES = ["work", "rework", "material_wait", "station_wait", "accident_stop"]

    def check(self, preset_id):
        exp = self.EXPECTED[preset_id]
        r = simulate(PRESETS[preset_id])
        self.assertEqual([s["delivered_day"] for s in r["ships"]], exp["delivered"])
        self.assertEqual([s["late_days"] for s in r["ships"]], exp["late"])
        q = r["qcd"]["quality"]
        self.assertEqual((q["passes"], q["inspections"]), exp["fpy"])
        self.assertEqual(r["qcd"]["delivery"]["on_time"], exp["on_time"])
        self.assertEqual(r["status"]["accidents"], exp["accidents"])
        for key, value in exp["costs"].items():
            self.assertAlmostEqual(r["costs"][key], value, places=2, msg=key)
        self.assertAlmostEqual(r["total_cost"], exp["total"], places=2)
        self.assertAlmostEqual(r["profit"], exp["profit"], places=2)
        for ship in r["ships"]:
            got = [(ship["spans"][p]["start"], ship["spans"][p]["end"]) for p in self.STATIONS]
            self.assertEqual(got, exp["spans"][ship["id"]], ship["id"])
            self.assertEqual([ship["breakdown"][s] for s in self.STATES], exp["breakdown"][ship["id"]], ship["id"])
            self.assertEqual(ship["lead_time"], sum(exp["breakdown"][ship["id"]]))
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

    def test_accident_days(self):
        accidents = lambda pid: [(e["station"], e["day"]) for e in simulate(PRESETS[pid])["events"] if e["type"] == "accident"]
        self.assertEqual(accidents("unmanaged"), [("block_assembly", 15), ("erection", 39)])
        self.assertEqual(accidents("all_in"), [("block_assembly", 15), ("erection", 33)])


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
        self.assertEqual(len(r["inventory_daily"]), r["days"])

    def test_suggested_order_days_match_managed_preset(self):
        got = suggest_order_days(PRESETS["managed"])
        want = {sid: ship["order_days"] for sid, ship in PRESETS["managed"]["ships"].items()}
        self.assertEqual(got, want)

    def test_preview(self):
        p = preview(PRESETS["managed"])
        self.assertEqual(p["stations"]["erection"], {"rate": 2.0, "defect_rate": 0.05})
        self.assertEqual(p["fixed_costs"], {"labor": 3900, "maintenance": 400})

    def test_invalid_config_is_rejected(self):
        cfg = copy.deepcopy(PRESETS["managed"])
        cfg["stations"]["sub_assembly"]["workers"] = 3
        cfg["ships"]["S2"]["priority"] = 1
        with self.assertRaises(ConfigError) as ctx:
            simulate(cfg)
        self.assertEqual(len(ctx.exception.messages), 2)


if __name__ == "__main__":
    unittest.main()
