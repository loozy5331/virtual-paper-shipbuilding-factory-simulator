"""블록 조립(4.25, D71) 검증. 규칙 문서 3장 "블록 조립"과 10장 예시 9.

이 기능의 테스트는 실습 시나리오(block)와, 그보다 작은 판(배 1~2척, 절단·가공을 건너뛰어 소조립이 첫 공정)으로 한다.
"""

import copy
import unittest

from shipyard import ConfigError, list_scenarios, load_presets, load_scenario, preview, simulate

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


class Dues(unittest.TestCase):
    """공정 납기와 블록 납기(규칙 문서 3장 "공정 납기와 블록 납기")."""

    def managed(self):
        return load_presets("block")[1]["config"]

    def test_default_back_calc(self):
        # 실습 S1(벌크선, 납기 32일): 탑재 32 → PE장 25 → 중조립 19 → 소조립 10 → 가공 5 → 절단 2
        dues = preview(self.managed())["dues"]
        self.assertEqual(dues["stations"]["S1"], {"cutting": 2, "processing": 5, "sub_assembly": 10,
                                                  "block_assembly": 19, "grand_assembly": 25, "erection": 32})
        self.assertEqual(dues["blocks"]["S1-SA1"], 10)
        self.assertEqual(dues["blocks"]["S1-GA2"], 25)
        self.assertEqual(len(dues["blocks"]), 3 * 14)

    def test_presets_fix_dock_due(self):
        # 실습 S2(예인선, 납기 34일)은 프리셋이 PE장 납기를 도크 일정 26일로 적어 둔다(역산값 30일보다 앞). 앞 공정은 26일에서 역산
        for preset in load_presets("block"):
            self.assertEqual(preset["config"]["due"], {"stations": {"S2": {"grand_assembly": 26}}})
        self.assertEqual(preview(self.managed())["dues"]["stations"]["S2"],
                         {"cutting": 12, "processing": 14, "sub_assembly": 17, "block_assembly": 22, "grand_assembly": 26, "erection": 34})

    def test_station_override_moves_upstream(self):
        # S1 PE장 납기를 20일로 당기면 앞 공정은 그 값에서 다시 역산한다: 중조립 14, 소조립 5, 가공·절단은 1일 아래로 → 1. 탑재는 그대로
        cfg = {**self.managed(), "due": {"stations": {"S1": {"grand_assembly": 20}}}}
        dues = preview(cfg)["dues"]
        self.assertEqual(dues["stations"]["S1"], {"cutting": 1, "processing": 1, "sub_assembly": 5,
                                                  "block_assembly": 14, "grand_assembly": 20, "erection": 32})
        self.assertEqual(dues["blocks"]["S1-GA1"], 20)

    def test_back_calc_floor_is_day_one(self):
        # 소조립을 3일로 당기면 가공 3 − 2 − 1 = 0, 절단은 더 앞선다 → 둘 다 1일. 계획 간트 끝(가공 2일)이 넘쳐 계획상 위험
        cfg = {**self.managed(), "due": {"stations": {"S3": {"sub_assembly": 3}}}}
        pv = preview(cfg)
        self.assertEqual((pv["dues"]["stations"]["S3"]["cutting"], pv["dues"]["stations"]["S3"]["processing"]), (1, 1))
        self.assertIn(("S3", "processing"), [(r["ship"], r["station"]) for r in pv["plan_risks"]])

    def test_block_override(self):
        cfg = {**self.managed(), "due": {"blocks": {"S3-SA1": 5}}}
        dues = preview(cfg)["dues"]["blocks"]
        self.assertEqual((dues["S3-SA1"], dues["S3-SA2"]), (5, 16))

    def test_due_validation(self):
        bad = [{"blocks": {"S9-SA1": 5}}, {"blocks": {"S3-SA1": 0}}, {"stations": {"S3": {"painting": 5}}},
               {"stations": {"S3": {"sub_assembly": 99}}}, {"ships": {}}]
        for due in bad:
            with self.subTest(due=due), self.assertRaises(ConfigError):
                preview({**self.managed(), "due": due})
        with self.assertRaises(ConfigError):   # 블록 조립 실습이 아닌 분기
            preview({**load_presets("simple")[1]["config"], "due": {"blocks": {}}})

    def test_block_lateness_example9(self):
        # 예시 9의 선박 순서: Y 소조립 블록은 4·4·4·4·5·5·5·5일에 끝나 공정 납기 3일을 모두 넘긴다(늦은 날 1×4 + 2×4 = 12)
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        cfg["due"] = {"stations": {"X": {"sub_assembly": 6}, "Y": {"sub_assembly": 3}}}
        r = simulate(cfg, sc, baseline=False)
        ys = [b for b in r["blocks"] if b["ship"] == "Y" and b["station"] == "sub_assembly"]
        self.assertEqual([b["late_days"] for b in ys], [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertFalse(any(b["on_time"] for b in ys))
        y = next(s for s in r["ships"] if s["id"] == "Y")
        self.assertEqual(y["station_dues"]["sub_assembly"], {"due": 3, "end": 5, "late_days": 2})
        x = next(s for s in r["ships"] if s["id"] == "X")
        self.assertEqual(x["station_dues"]["sub_assembly"], {"due": 6, "end": 3, "late_days": 0})

    def test_summary_and_management(self):
        # 무관리 프리셋: S3 소조립이 납기 16일보다 9일 늦게 끝난다. 블록 납기 요약은 7관리 일정에도 실린다(등급 점수 밖)
        r = simulate(load_presets("block")[0]["config"], baseline=False)
        s3 = next(s for s in r["ships"] if s["id"] == "S3")
        self.assertEqual(s3["station_dues"]["sub_assembly"]["late_days"], 9)
        self.assertEqual(r["block_due"]["blocks"], 42)
        self.assertLess(r["block_due"]["on_time"], 42)
        self.assertEqual(r["management"]["schedule"]["block_due"], r["block_due"])
        # B안(선박 순서의 블록 순서)은 인도 납기는 다 지키지만 S2의 도크 일정(PE장 26일)을 넘기는 블록이 있다
        managed = simulate(self.managed(), baseline=False)
        self.assertTrue(all(s["on_time"] for s in managed["ships"]))
        self.assertLess(managed["block_due"]["rate"], 1.0)


class Dispatch(unittest.TestCase):
    """우선순위 규칙 4종과 블록 순서(규칙 문서 3장 "우선순위 규칙과 추천"). 예시 9의 판으로 본다."""

    def run_sub(self, rule, ship_dues=(40, 40), priorities=(1, 2)):
        cfg, sc = mini([("X", "FEEDER", priorities[0], ship_dues[0]), ("Y", "TUG", priorities[1], ship_dues[1])])
        cfg["stations"]["sub_assembly"]["dispatch"] = rule
        cfg["due"] = {"stations": {"X": {"sub_assembly": 6}, "Y": {"sub_assembly": 3}}}
        r = simulate(cfg, sc, baseline=False)
        return done_days(r, "X", "sub_assembly"), done_days(r, "Y", "sub_assembly")

    def test_edd_takes_earlier_block_due(self):
        # X가 1순위여도 납기 빠른 순이면 블록 납기 3일인 Y부터: 예시 9의 오른쪽 열
        self.assertEqual(self.run_sub("edd"), ([3, 3, 4, 4, 4, 5, 5, 5], [1, 1, 1, 1, 2, 2, 2, 2]))

    def test_spt_takes_smaller_blocks(self):
        # 작업 짧은 순: 예인선 블록(0.5)이 피더 블록(0.75)보다 먼저
        self.assertEqual(self.run_sub("spt")[1], [1, 1, 1, 1, 2, 2, 2, 2])

    def test_slack_uses_ship_due(self):
        # 여유 = 인도 납기 − 오늘 − 남은 공정 이상 소요일. Y 인도 납기가 20일이면 Y부터, 60일이면 X부터
        self.assertEqual(self.run_sub("slack", ship_dues=(40, 20))[1], [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(self.run_sub("slack", ship_dues=(40, 60))[0], [1, 1, 2, 2, 2, 3, 3, 3])

    def test_ship_rule_is_default(self):
        self.assertEqual(self.run_sub("ship"), ([1, 1, 2, 2, 2, 3, 3, 3], [4, 4, 4, 4, 5, 5, 5, 5]))

    def test_block_order_list(self):
        # 블록 순서: Y 블록을 모두 앞에 두면(선박 순서 규칙이어도) 예시 9의 납기 빠른 순과 같다
        order = [f"Y-SA{k}" for k in range(1, 9)] + [f"X-SA{k}" for k in range(1, 9)]
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        cfg["block_order"] = {"sub_assembly": order}
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "Y", "sub_assembly"), [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(done_days(r, "X", "sub_assembly"), [3, 3, 4, 4, 4, 5, 5, 5])

    def test_partial_order_goes_first(self):
        # 목록에 적은 블록만 앞으로, 나머지는 규칙대로: Y가 1순위여도 X-SA8이 맨 먼저(1일에 X-SA8 0.75, Y1·Y2, Y3 0.25)
        cfg, sc = mini([("X", "FEEDER", 2, 40), ("Y", "TUG", 1, 40)])
        cfg["block_order"] = {"sub_assembly": ["X-SA8"]}
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X", "sub_assembly")[7], 1)
        self.assertEqual(done_days(r, "Y", "sub_assembly")[:3], [1, 1, 2])

    def test_dispatch_validation(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        for change in ({"stations": {"sub_assembly": {"dispatch": "fifo"}}}, {"stations": {"erection": {"dispatch": "edd"}}},
                       {"block_order": {"sub_assembly": ["X-SA9"]}}, {"block_order": {"sub_assembly": ["X-SA1", "X-SA1"]}},
                       {"block_order": {"sub_assembly": ["X-BA1"]}}, {"block_order": {"erection": []}}):
            bad = {**cfg, "stations": {k: dict(v) for k, v in cfg["stations"].items()}}
            for sid, st in change.get("stations", {}).items():
                bad["stations"][sid].update(st)
            if "block_order" in change:
                bad["block_order"] = change["block_order"]
            with self.subTest(change=change), self.assertRaises(ConfigError):
                simulate(bad, sc, baseline=False)
        simple = load_presets("simple")[1]["config"]
        for bad in ({**simple, "block_order": {}},
                    {**simple, "stations": {**simple["stations"], "sub_assembly": {**simple["stations"]["sub_assembly"], "dispatch": "edd"}}}):
            with self.assertRaises(ConfigError):
                simulate(bad, baseline=False)


class BlockPlan(unittest.TestCase):
    """블록 계획 일정(미리보기 block_plan): 계획 간트에서 공정을 펼치면 보이는 블록 막대."""

    def test_example9_plan(self):
        # 예시 9 판의 계획: 소조립 X 블록은 1·1·2·2·2·3·3·3일, Y는 4·4·4·4·5·5·5·5일에 끝난다(실행과 같다, 고장 없음)
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        bp = preview(cfg, sc)["block_plan"]
        ends = lambda ship: [bp["blocks"][f"{ship}-SA{k}"]["end"] for k in range(1, 9)]
        self.assertEqual(ends("X"), [1, 1, 2, 2, 2, 3, 3, 3])
        self.assertEqual(ends("Y"), [4, 4, 4, 4, 5, 5, 5, 5])
        self.assertEqual(bp["order"]["sub_assembly"][:2], ["X-SA1", "X-SA2"])
        # 중조립 1번 블록은 소조립 1·2번이 끝난 다음 날(2일)부터
        self.assertEqual(bp["blocks"]["X-BA1"]["start"], 2)

    def test_order_changes_plan_and_risk(self):
        # Y를 앞에 두면 Y 블록이 1~2일에 끝나고, X 블록 납기 2일은 계획상 위험
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        cfg["block_order"] = {"sub_assembly": [f"Y-SA{k}" for k in range(1, 9)]}
        cfg["due"] = {"blocks": {"X-SA1": 2}}
        bp = preview(cfg, sc)["block_plan"]
        self.assertEqual(bp["order"]["sub_assembly"][:8], [f"Y-SA{k}" for k in range(1, 9)])
        self.assertEqual(bp["blocks"]["X-SA1"]["end"], 3)
        self.assertIn("X-SA1", bp["risks"])

    def test_listed_order_is_shown_even_if_block_arrives_later(self):
        # 목록 맨 앞이어도 아직 닿지 않은 블록은 기다리지 않는다: 실습 A안에서 S1-SA1(5일에 닿음)을 맨 앞에 두면
        # 보이는 순서는 목록 그대로(S1-SA1이 첫 줄)이고, 막대는 3일에 닿는 S2 블록보다 늦다
        cfg = {**load_presets("block")[0]["config"], "block_order": {"sub_assembly": ["S1-SA1"]}}
        bp = preview(cfg)["block_plan"]
        self.assertEqual(bp["order"]["sub_assembly"][:2], ["S1-SA1", "S2-SA1"])
        self.assertGreater(bp["blocks"]["S1-SA1"]["start"], bp["blocks"]["S2-SA1"]["start"])

    def test_preset_sets_first_order(self):
        # B안(관리)은 처음 블록 순서를 우선순위대로 S1(벌크선) 블록부터 둔다
        managed = load_presets("block")[1]["config"]
        self.assertEqual(managed["block_order"]["sub_assembly"][:2], ["S1-SA1", "S1-SA2"])
        self.assertEqual(preview(managed)["block_plan"]["order"]["sub_assembly"][0], "S1-SA1")


class BlockStart(unittest.TestCase):
    """블록 착수일(4.26, block_start): 정한 블록은 그날보다 먼저 들이지 않는다(규칙 문서 3장 "우선순위 규칙과 추천")."""

    def test_block_waits_until_start_day(self):
        # 예시 9의 판(선박 순서)에서 X-SA1만 4일로: 1~3일은 작업장 대기, 그동안 X의 나머지와 Y-SA1·2가 먼저 한다.
        # 4일: Y-SA2 나머지 0.25 → X-SA1 0.75 → Y-SA3·4 0.5씩. 계획 일정(block_plan)도 같은 답
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        cfg["block_start"] = {"X-SA1": 4}
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X", "sub_assembly"), [4, 1, 1, 2, 2, 2, 3, 3])
        self.assertEqual(done_days(r, "Y", "sub_assembly"), [3, 4, 4, 4, 5, 5, 5, 5])
        x1 = next(b for b in r["blocks"] if b["id"] == "X-SA1")
        self.assertEqual([d["state"] for d in x1["daily"][:4]], ["station_wait"] * 3 + ["work"])
        bp = preview(cfg, sc)["block_plan"]["blocks"]
        self.assertEqual((bp["X-SA1"]["start"], bp["X-SA1"]["end"]), (4, 4))
        self.assertEqual((bp["Y-SA1"]["start"], bp["Y-SA1"]["end"]), (3, 3))

    def test_pinned_block_goes_before_listed_order(self):
        # B안은 블록 순서 목록이 S1 블록을 앞에 둔다. S2-BA4는 11일에 들어갈 수 있지만(ready) S1 블록을 하느라 15일에 시작한다.
        # 11일로 정하면 11일에 S1 블록보다 먼저 들어간다(막대가 놓은 자리에 머문다)
        cfg = copy.deepcopy(load_presets("block")[1]["config"])
        ba4 = preview(cfg)["block_plan"]["blocks"]["S2-BA4"]
        self.assertEqual((ba4["ready"], ba4["start"]), (11, 15))
        cfg["block_start"] = {"S2-BA4": 11}
        self.assertEqual(preview(cfg)["block_plan"]["blocks"]["S2-BA4"]["start"], 11)

    def test_validation(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        for bad in [{"X-SA9": 3}, {"X-SA1": 0}, {"X-SA1": 99}, ["X-SA1"]]:
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                simulate({**cfg, "block_start": bad}, sc, baseline=False)
        with self.assertRaises(ConfigError):   # 블록 조립 실습이 아닌 분기
            preview({**load_presets("simple")[1]["config"], "block_start": {}})

    def test_recommend_keeps_start_days(self):
        # 추천은 블록 순서만 비우고 착수일은 그대로 둔다: 착수일을 늦추면 네 규칙의 비교도 따라 바뀐다
        cfg = copy.deepcopy(load_presets("block")[1]["config"])
        base = simulate(cfg, baseline=False)["recommend"]["rules"]
        cfg["block_start"] = {f"S1-SA{k}": 9 for k in range(1, 9)}
        later = simulate(cfg, baseline=False)["recommend"]["rules"]
        self.assertNotEqual([r["profit"] for r in base], [r["profit"] for r in later])


class Recommend(unittest.TestCase):
    """평가서 추천: 블록 공정 규칙만 바꿔 4번 더 돌리고 인도 납기 → 블록 납기 → 이익 → 직행률 순으로 고른다."""

    def rows(self, preset):
        rc = simulate(load_presets("block")[preset]["config"], baseline=False)["recommend"]
        return rc, {row["rule"]: row for row in rc["rules"]}

    def test_managed_gets_edd(self):
        # B안: 네 규칙이 모두 다른 답(⑧ 조율). 인도 납기는 SPT만 놓치고(큰 S1을 미룸), 블록 납기는 지정한 S2 PE장 납기를 따르는
        # 납기 빠른 순(EDD)이 가장 높다. 인도 납기만 보는 여유 작은 순(slack)은 선박 순서보다도 낮다
        rc, rows = self.rows(1)
        self.assertEqual([row["rule"] for row in rc["rules"]], ["ship", "edd", "slack", "spt"])
        self.assertEqual([rows[k]["on_time"] for k in ("ship", "edd", "slack", "spt")], [3, 3, 3, 2])
        self.assertGreater(rows["edd"]["block_rate"], rows["ship"]["block_rate"])
        self.assertGreater(rows["ship"]["block_rate"], rows["slack"]["block_rate"])
        self.assertEqual(len({(r["on_time"], r["block_rate"], r["profit"]) for r in rc["rules"]}), 4)
        self.assertEqual(rc["best"], "edd")
        self.assertFalse(rc["current_is_best"])
        self.assertTrue(rc["current"]["block_order"])

    def test_dock_due_splits_edd_and_slack(self):
        # B안에서 규칙만 바꾸면: 여유 작은 순은 인도 납기만 봐서 S2 PE장을 28일에 끝내 도크 일정 26일을 넘기고,
        # 납기 빠른 순은 21일에 지킨다. 도크 일정(공정 납기)을 지우면 둘은 같은 답이다
        def s1_pe_end(rule, dock=True):
            cfg = copy.deepcopy(load_presets("block")[1]["config"])
            cfg.pop("block_order")
            if not dock:
                cfg.pop("due")
            for sid in ("sub_assembly", "block_assembly", "grand_assembly"):
                cfg["stations"][sid]["dispatch"] = rule
            r = simulate(cfg, baseline=False)
            return next(s for s in r["ships"] if s["id"] == "S2")["station_dues"]["grand_assembly"]["end"], r["block_due"]["rate"]
        self.assertEqual((s1_pe_end("slack")[0], s1_pe_end("edd")[0]), (28, 21))
        self.assertEqual(s1_pe_end("slack", dock=False), s1_pe_end("edd", dock=False))

    def test_unmanaged_rule_alone_cannot_save_all(self):
        # 무관리(작은 배부터: 예인선 S2 → 벌크선 S1 → S3): 규칙만으로는 3척을 다 지키지 못한다. 작업 짧은 순은 척수로 앞서지만 큰 S1을 크게 늦춘다
        rc, rows = self.rows(0)
        self.assertEqual(rc["best"], "spt")
        self.assertTrue(all(r["on_time"] < 3 for r in rc["rules"]))
        self.assertLess(rows["spt"]["profit"], rows["ship"]["profit"])
        self.assertEqual(rc["current"]["rules"], {"sub_assembly": "ship", "block_assembly": "ship", "grand_assembly": "ship"})

    def test_only_in_block_drill(self):
        self.assertNotIn("recommend", simulate(load_presets("simple")[1]["config"], baseline=False))


class DrillScenario(unittest.TestCase):
    def test_listed_last_as_drill(self):
        # 사다리(D67) 밖 실습: 첫 화면 목록의 맨 끝, track "drill"(난이도 점 대신 "실습" 카드)
        # 4.30(D77): 조립 현장 배정(assembly)이 블록 조립 실습 다음. 첫 화면은 실습을 사다리 아래 줄에 따로 놓는다
        # 4.32.1(사용자): 조립 공정 실습은 하나만. 블록 조립 실습은 목록에서 숨기고 불러오기는 그대로
        # 4.43(D91): 작업 배정(dispatch)이 조립 현장 배정 다음. 4.46(D94, 사용자): 조립 현장 배정을 지워 작업 배정 하나
        listed = list_scenarios()
        self.assertEqual([(s["id"], s.get("track")) for s in listed[-1:]], [("dispatch", "drill")])
        self.assertNotIn("block", [s["id"] for s in listed])
        self.assertNotIn("assembly", [s["id"] for s in listed])
        self.assertTrue(all("track" not in s for s in listed[:-1]))
        self.assertTrue(load_scenario("block")["block_mode"])
        with self.assertRaises(ConfigError):
            load_scenario("assembly")

    def test_other_scenarios_have_no_blocks(self):
        r = simulate(load_presets("simple")[1]["config"], baseline=False)
        self.assertNotIn("blocks", r)

    def test_presets_and_grade_d70(self):
        # 등급 조율(D70, 4.25 ⑧): B안은 A, B안에 선배의 팁 셋(조립 2명·탑재 1명·자동화 연구)을 반영하면 S
        presets = {p["id"]: p["config"] for p in load_presets("block")}
        cases = {"unmanaged": (2839.8, 67.4, "C", 1), "managed": (4288.0, 94.3, "A", 3), "all_in": (-6150.8, 59.6, "C", 3)}
        for pid, want in cases.items():
            r = simulate(presets[pid])
            self.assertEqual((r["profit"], r["grade"]["score"], r["grade"]["grade"], r["qcd"]["delivery"]["on_time"]), want, pid)
        tips = copy.deepcopy(presets["managed"])
        tips["pools"].update({"assembly": 2, "erection": 1})
        tips["research"] = ["automation"]
        r = simulate(tips)
        self.assertEqual((r["grade"]["grade"], r["qcd"]["delivery"]["on_time"]), ("S", 3))

    def test_ship_order_misses_bulk(self):
        # 실습의 판(4.25 ⑧): 작은 배(예인선 S2)부터 하면 가장 크고 납기가 빠른 벌크선 S1(32일)과 S3가 늦는다. S1을 1순위로 두면 다 지킨다
        unmanaged, managed, _ = load_presets("block")
        late = {s["id"]: s["late_days"] for s in simulate(unmanaged["config"], baseline=False)["ships"]}
        self.assertGreater(late["S1"], 0)
        self.assertGreater(late["S3"], 0)
        self.assertTrue(all(s["on_time"] for s in simulate(managed["config"], baseline=False)["ships"]))


if __name__ == "__main__":
    unittest.main()


def times(result, ship, station):
    """블록마다 (시작일, 시작 시각, 끝일, 끝 시각)."""
    return [(b["start"], b["start_h"], b["end"], b["end_h"]) for b in result["blocks"]
            if b["ship"] == ship and b["station"] == station]


class Example10(unittest.TestCase):
    """10장 예시 10, 공수와 시각(4.29, D76): 예시 9의 판(소조립 작업장 1곳, 조립 2명 = 시간당 2 MH).
    X 피더 블록 0.75 × 8 = 6 MH(3시간), Y 예인선 블록 4 MH(2시간)."""

    def test_hours_and_manhours(self):
        # 선박 순서: X-SA1 1일 0~3시간, X-SA2 3~6시간, X-SA3 1일 6시간 → 2일 1시간. X는 3일 끝, Y는 4·5일
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(times(r, "X", "sub_assembly")[:3], [(1, 0, 1, 3), (1, 3, 1, 6), (1, 6, 2, 1)])
        self.assertEqual(times(r, "X", "sub_assembly")[-1], (3, 5, 3, 8))
        self.assertEqual(times(r, "Y", "sub_assembly")[0], (4, 0, 4, 2))
        x1 = r["blocks"][0]
        self.assertEqual((x1["std_mh"], x1["mh"], x1["rework_mh"], x1["day_hours"]), (6, 6, 0, 8))
        sa = r["manhours"]["stations"]["sub_assembly"]
        self.assertEqual(sa, {"planned": 80, "standard": 80, "input": 80, "work": 80, "rework": 0, "idle": 0, "efficiency": 1})
        # 계획 일정도 같은 시계
        bp = preview(cfg, sc)["block_plan"]["blocks"]
        self.assertEqual([(bp[f"X-SA{k}"]["start_h"], bp[f"X-SA{k}"]["end_h"]) for k in (1, 2, 3)], [(0, 3), (3, 6), (6, 1)])
        self.assertEqual(bp["X-SA1"]["std_mh"], 6)

    def test_start_hour_idles_station(self):
        # X 혼자, X-SA1은 1일 2시간, 나머지 X 블록은 2일로: 1일은 0~2시간 쉬고 X-SA1 2~5시간, 다시 5~8시간 쉰다.
        # 2일부터 X-SA2…8을 이어 하고 X-SA8은 4일 2~5시간. 투입 64 MH = 작업 48 + 대기 16(1일 10 + 4일 6), 공수 효율 0.75
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        cfg["block_start"] = {"X-SA1": 1, **{f"X-SA{k}": 2 for k in range(2, 9)}}
        cfg["block_start_hour"] = {"X-SA1": 2}
        r = simulate(cfg, sc, baseline=False)
        t = times(r, "X", "sub_assembly")
        self.assertEqual((t[0], t[1], t[-1]), ((1, 2, 1, 5), (2, 0, 2, 3), (4, 2, 4, 5)))
        sa = r["manhours"]["stations"]["sub_assembly"]
        self.assertEqual((sa["input"], sa["work"], sa["idle"], sa["efficiency"]), (64, 48, 16, 0.75))
        bp = preview(cfg, sc)["block_plan"]["blocks"]
        self.assertEqual((bp["X-SA1"]["start_h"], bp["X-SA1"]["end_h"], bp["X-SA8"]["end"], bp["X-SA8"]["end_h"]), (2, 5, 4, 5))
        self.assertEqual((bp["X-SA1"]["ready"], bp["X-SA1"]["ready_h"]), (1, 2))   # 대기 띠는 착수 시각부터

    def test_start_hour_does_not_hold_station(self):
        # Y-SA1을 1일 2시간으로 정하고 X와 함께: 0시간에 들어올 수 있는 X-SA1이 먼저 3시간까지,
        # Y-SA1은 3~5시간(작업장을 비워 두지 않고 하던 블록을 밀어내지 않는다), 그다음 X-SA2 5~8시간
        cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
        cfg["block_start"] = {"Y-SA1": 1}
        cfg["block_start_hour"] = {"Y-SA1": 2}
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(times(r, "Y", "sub_assembly")[0], (1, 3, 1, 5))
        self.assertEqual(times(r, "X", "sub_assembly")[:2], [(1, 0, 1, 3), (1, 5, 1, 8)])
        bp = preview(cfg, sc)["block_plan"]["blocks"]
        self.assertEqual((bp["Y-SA1"]["start_h"], bp["X-SA2"]["start_h"]), (3, 5))

    def test_overtime_day_is_ten_hours(self):
        # 잔업: 처리량 2.5 = 시간당 2 MH로 10시간. X-SA4는 1일 9시간에 시작해 2일 2시간에 끝난다(1시간 2 MH + 2시간 4 MH)
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        cfg["stations"]["sub_assembly"]["overtime"] = True
        r = simulate(cfg, sc, baseline=False)
        x4 = next(b for b in r["blocks"] if b["id"] == "X-SA4")
        self.assertEqual((x4["start"], x4["start_h"], x4["end"], x4["end_h"], x4["day_hours"]), (1, 9, 2, 2, 10))
        self.assertEqual(sc["rules"]["overtime"]["speed"],
                         (sc["rules"]["hours"]["day"] + sc["rules"]["hours"]["overtime"]) / sc["rules"]["hours"]["day"])

    def test_rework_counts_as_rework_manhours(self):
        # 불량 블록은 재작업 절반(3 MH)을 더 한다: 그 블록 mh 9 = 작업 6 + 재작업 3. 실적 표준 공수는 그대로 6
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        sc["random"]["block_quality"]["X"]["sub_assembly"][0] = 0.0
        r = simulate(cfg, sc, baseline=False)
        x1 = r["blocks"][0]
        self.assertEqual((x1["mh"], x1["rework_mh"]), (9, 3))
        sa = r["manhours"]["stations"]["sub_assembly"]
        self.assertEqual((sa["standard"], sa["rework"]), (48, 3))

    def test_validation(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        cfg["block_start"] = {"X-SA1": 2}
        for bad in [{"X-SA2": 3}, {"X-SA1": 8}, {"X-SA1": -1}, {"X-SA1": 1.5}, ["X-SA1"]]:
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                simulate({**cfg, "block_start_hour": bad}, sc, baseline=False)

    def test_same_as_before_without_start_hour(self):
        # 착수 시각을 정하지 않으면 시각은 기록뿐: 실습 B안 결과에 공수가 붙을 뿐 등급은 그대로(94.3)
        r = simulate(load_presets("block")[1]["config"])
        self.assertEqual(r["grade"]["score"], 94.3)
        self.assertEqual(r["manhours"]["total"]["planned"], 520)
        self.assertNotIn("manhours", simulate(load_presets("simple")[1]["config"], baseline=False))
