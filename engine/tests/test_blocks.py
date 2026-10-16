"""블록 조립(4.25, D71) 검증. 규칙 문서 3장 "블록 조립"과 10장 예시 9.

이 기능의 테스트는 실습 시나리오(block)와, 그보다 작은 판(배 1~2척, 절단·가공을 건너뛰어 소조립이 첫 공정)으로 한다.
"""

import unittest

from shipyard import ConfigError, list_scenarios, load_presets, load_scenario, simulate

ASSEMBLY = ("sub_assembly", "block_assembly", "grand_assembly", "erection")


def mini(ships, units=1):
    """예시 9의 판: 소조립부터 시작(절단·가공 건너뜀), 블록 불량 없음, 자재는 처음 재고로 넉넉히.

    ships = [(배, 선종, 우선순위, 납기)]. 모두 1일 착수.
    """
    sc = load_scenario("block")
    sc.pop("options")
    sc["stations"] = [{**s, "skipped": True, "material": None} if s["id"] in ("cutting", "processing") else s
                      for s in sc["stations"]]
    sc["skip"] = sc["skip"] + ["cutting", "processing"]
    sc["orders"] = [{"id": sid, "type": t, "order_day": 1, "due_day": due, "price": 3000} for sid, t, _, due in ships]
    sc["initial_stock"] = {"paper": 50, "paint": 50, "flag": 50, "insulation": 0}
    sc["random"]["quality"] = {sid: {s["id"]: 0.99 for s in sc["stations"]} for sid, *_ in ships}
    sc["random"]["block_quality"] = {sid: {"sub_assembly": [0.99] * 8, "block_assembly": [0.99] * 4,
                                           "grand_assembly": [0.99] * 2} for sid, *_ in ships}
    cfg = {"scenario": "block",
           "ships": {sid: {"priority": pr, "start_day": 1} for sid, _, pr, _ in ships},
           "pools": {"assembly": 6, "erection": 2},   # 조립 세 공정에 2명씩: 소조립이 인력 대기 없이 늘 2명
           "transporters": {"count": 1, "maintenance": True}, "forklifts": {"count": 2, "maintenance": True},
           "research": [],
           "stations": {st: {"method": "standard", "overtime": False, "maintenance": True,
                             **({"units": units} if st != "erection" else {})} for st in ASSEMBLY}}
    return cfg, sc


def done_days(result, ship, station):
    return [b["done_day"] for b in result["blocks"] if b["ship"] == ship and b["station"] == station]


class Example9(unittest.TestCase):
    """10장 예시 9: 소조립 작업장 1곳, 조립 2명(처리량 하루 2). X 피더(블록 0.75), Y 예인선(블록 0.5)."""

    def test_carry_ship_order(self):
        # 선박 순서(X 먼저): X는 1·1·2·2·2·3·3·3일, Y는 4일과 5일에 넷씩. Y 소조립은 5일(공정 납기 3일보다 2일 늦음)
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X", "sub_assembly"), [1, 1, 2, 2, 2, 3, 3, 3])
        self.assertEqual(done_days(r, "Y", "sub_assembly"), [4, 4, 4, 4, 5, 5, 5, 5])

    def test_deadline_first(self):
        # Y를 먼저(납기 빠른 순과 같은 순서): Y는 2일, X는 5일에 끝나 두 배 모두 공정 납기(Y 3일, X 6일)를 지킨다
        cfg, sc = mini([("X", "FEEDER", 2, 40), ("Y", "TUG", 1, 40)])
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "Y", "sub_assembly"), [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(done_days(r, "X", "sub_assembly"), [3, 3, 4, 4, 4, 5, 5, 5])

    def test_blocks_flow_ahead(self):
        # X 혼자: 소조립 블록이 2일(X1·X2), 3일(X3~X5), 4일(X6~X8)에 중조립 앞에 닿고, 중조립(블록 2.5)은 3·4·5·6일에 끝난다.
        # 로트로 셌다면 중조립은 9일에 끝난다(소조립 3일 → 운반 4·5일 → 중조립 5~9일)
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X", "block_assembly"), [3, 4, 5, 6])
        x = r["ships"][0]
        self.assertEqual(x["spans"]["block_assembly"], {"start": 2, "end": 6})
        blocks = {b["id"]: b for b in r["blocks"]}
        # 운반: 끝난 다음 날 실어 그날 닿는다. X5는 3일에 닿고 짝 X6이 4일에 닿을 때까지 짝 대기
        self.assertEqual(blocks["X-SA1"]["daily"][1]["state"], "transport")
        self.assertEqual(blocks["X-SA5"]["daily"][3]["state"], "pair_wait")
        # 다음 공정 블록이 된 뒤에는 완료, 만들어지기 전(앞 블록을 기다리는 동안)은 착수 전
        self.assertEqual(blocks["X-SA1"]["daily"][2]["state"], "done")
        self.assertEqual(blocks["X-BA4"]["daily"][3]["state"], "not_started")


class BlockRules(unittest.TestCase):
    def test_two_stations_spread(self):
        # 작업장 2곳이면 같은 배의 블록이 두 곳으로 퍼진다: X 소조립 6을 하루 4씩 → 2일에 끝
        cfg, sc = mini([("X", "FEEDER", 1, 40)], units=2)
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(max(done_days(r, "X", "sub_assembly")), 2)
        self.assertEqual({b["unit"] for b in r["blocks"] if b["station"] == "sub_assembly"}, {1, 2})

    def test_block_defect_and_rework(self):
        # 불량은 블록마다: X 소조립 3번 블록만 불량 → 그 블록 작업량의 50%(0.375)를 같은 작업장에서 바로 재작업.
        # 재작업비는 블록 하나에 200 ÷ 8 = 25
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        sc["random"]["block_quality"]["X"]["sub_assembly"][2] = 0.0
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(r["costs"]["rework"], 25.0)
        defects = [e for e in r["events"] if e["type"] == "defect"]
        self.assertEqual([(e["block"], e["day"]) for e in defects], [("X-SA3", 2)])
        # 1일: X1·X2 + X3 0.5, 2일: X3 0.25 → 불량, 재작업 0.375, X4 0.75, X5 0.625 → X3·X4 끝
        self.assertEqual(done_days(r, "X", "sub_assembly")[:5], [1, 1, 2, 2, 3])
        sub = next(s for s in r["stations"] if s["id"] == "sub_assembly")
        self.assertEqual((sub["inspections"], sub["passes"]), (8, 7))

    def test_result_shape(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(len(r["blocks"]), 2 * (8 + 4 + 2))
        self.assertTrue(all(len(b["daily"]) == sc["days"] for b in r["blocks"]))
        self.assertEqual(r["blocks"][0]["id"], "X-SA1")
        # 배는 블록이 모두 끝나야 그 공정을 마친다: 탑재는 PE장 블록 둘이 끝난 다음 날(크레인)
        x = r["ships"][0]
        last_ga = max(done_days(r, "X", "grand_assembly"))
        self.assertEqual(x["spans"]["erection"]["start"], last_ga + 1)

    def test_split_not_allowed_on_block_station(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        cfg["stations"]["sub_assembly"]["split"] = True
        with self.assertRaises(ConfigError):
            simulate(cfg, sc, baseline=False)


class DrillScenario(unittest.TestCase):
    def test_hidden_from_ladder_but_loadable(self):
        # 사다리(D67) 밖 실습: 첫 화면 목록에는 아직 없고(실습 카드는 생산계획서 PR에서), 이름으로는 불러 돌릴 수 있다
        self.assertNotIn("block", [s["id"] for s in list_scenarios()])
        self.assertTrue(load_scenario("block")["block_mode"])

    def test_other_scenarios_have_no_blocks(self):
        r = simulate(load_presets("simple")[1]["config"], baseline=False)
        self.assertNotIn("blocks", r)

    def test_ship_order_misses_tug(self):
        # 실습의 판(초안): 수주 번호 순서로만 하면 번호가 늦은 예인선 S3가 납기 30일을 넘긴다. S3를 1순위로 두면 지킨다
        unmanaged, managed, _ = load_presets("block")
        late = {s["id"]: s["late_days"] for s in simulate(unmanaged["config"], baseline=False)["ships"]}
        self.assertGreater(late["S3"], 0)
        self.assertTrue(all(s["on_time"] for s in simulate(managed["config"], baseline=False)["ships"]))


if __name__ == "__main__":
    unittest.main()
