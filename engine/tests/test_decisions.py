"""몰리는 날의 결정(4.31·4.32, D78·D79) 검증. 규칙 문서 3장 "몰리는 날의 결정"과 10장 예시 11·12.

결정은 예시 9의 판(test_blocks.mini)으로 손 계산한다. 실습 판(조립 현장 배정 assembly)은 4.46에서 지웠다(D94).
"""

import copy
import unittest

from shipyard import ConfigError, load_presets, simulate

from tests.test_blocks import mini


def manual_mini(budget=100):
    """예시 9의 판(X 피더 1순위, Y 예인선 2순위, 소조립 작업장 1곳, 조립 6명 = 가용 48 MH)에서 소조립을 직접 대응으로."""
    cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
    sc["options"] = {"crews": ["normal"], "methods": ["standard"], "material_grades": ["standard"], "max_units": 2,
                     "split": False, "decisions": True}
    sc["decision_stations"] = ["sub_assembly"]
    sc["contingency"] = {"sub_assembly": budget}
    sc["contingency_max"] = 500
    cfg["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
    return cfg, sc


def done_days(result, ship):
    return [b["done_day"] for b in result["blocks"] if b["ship"] == ship and b["station"] == "sub_assembly"]


class Example11(unittest.TestCase):
    """10장 예시 11: 1일에 X 소조립 8블록(6 MH씩 48)과 Y 8블록(4 MH씩 32)이 함께 기다린다. 80 MH > 가용 48 MH, 두 척 → 묻는다."""

    def test_pending_on_crunch_day(self):
        cfg, sc = manual_mini()
        r = simulate(cfg, sc, baseline=False)
        pd = r["pending"]
        self.assertEqual((pd["day"], pd["need_mh"], pd["capacity_mh"]), (1, 80, 48))
        st = pd["stations"]["sub_assembly"]
        self.assertEqual((len(st["waiting"]), st["budget"], st["budget_left"], st["policy"]), (16, 100, 100, None))
        self.assertEqual(st["rule_orders"]["spt"][:2], ["Y-SA1", "Y-SA2"])   # 작업 짧은 순: Y 블록(0.5)이 X(0.75)보다 먼저
        # 묻는 동안은 자동 대응(선박 순서)으로 끝까지 돈다: 예시 9와 같다
        self.assertEqual(done_days(r, "X"), [1, 1, 2, 2, 2, 3, 3, 3])

    def test_policy_spt(self):
        # 작업 짧은 순 정책: 하루 처리량 2로 Y 블록(0.5) 4개씩 1·2일, X 블록(0.75)은 3일부터 3·3·4·4·4·5·5·5
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "policy": {"sub_assembly": "spt"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertIsNone(r["pending"])
        self.assertEqual(done_days(r, "Y"), [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(done_days(r, "X"), [3, 3, 4, 4, 4, 5, 5, 5])

    def test_quotes(self):
        # 견적(정원 2명): X 블록 0.75 → 잔업 1일(2 × 10 × 0.5 = 10), 철야 1일(2 × 10 × 1.5 = 30),
        # 외주 0.75 × 10 × 2 = 15, 0.75 ÷ 2 → 1일 + 운반 2일 = 3일 뒤(4일) 돌아온다
        cfg, sc = manual_mini()
        q = simulate(cfg, sc, baseline=False)["pending"]["stations"]["sub_assembly"]["waiting"][0]["quotes"]
        self.assertEqual((q["overtime"]["cost"], q["extra"]["cost"], q["outsource"]["cost"], q["outsource"]["back_day"]), (10, 30, 15, 4))


class Example12(unittest.TestCase):
    """10장 예시 12, 블록 조치(4.32): 예시 11의 1일."""

    def test_outsource_returns_after_transport(self):
        # X-SA1 외주: 대기열을 떠나 4일에 소조립을 마친 블록으로 돌아온다(직접 하면 1일에 끝났을 블록이 3일 늦는다).
        # 나머지 X 블록은 하나씩 앞당겨진다. 비용 15는 비상 예산에서
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "outsource"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X")[0], 4)
        self.assertEqual(r["costs"]["emergency"], 15)
        self.assertTrue(any(e["type"] == "outsource" and e["back_day"] == 4 for e in r["events"]))

    def test_overtime_speeds_block(self):
        # X-SA1 잔업: 그 블록이 든 날 작업장은 10시간(처리량 2.5). 1일에 X-SA1(0.75)·SA2·SA3(+0.25) → X-SA3이 1일에 끝나지 않고
        # 이어 하기: 2.5 = 0.75 × 3 + 0.25. 1일 끝난 블록은 셋(정규 하루는 둘)
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "overtime"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X")[:3], [1, 1, 1])
        self.assertEqual(r["costs"]["emergency"], 10)

    def test_defer_goes_last(self):
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "defer"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(max(done_days(r, "X") + done_days(r, "Y")), done_days(r, "X")[0])

    def test_over_budget_refused(self):
        # 예산 20: 잔업(10) + 외주(15)는 넘친다 → 외주는 거절되어 기록된다
        cfg, sc = manual_mini(budget=20)
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "overtime", "X-SA2": "outsource"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual((r["decisions"][0]["actions"], r["decisions"][0]["refused"]), ({"X-SA1": "overtime"}, {"X-SA2": "over_budget"}))
        self.assertEqual(r["costs"]["emergency"], 10)

    def test_review_rows(self):
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "policy": {"sub_assembly": "spt"}, "actions": {"X-SA1": "overtime"}}]
        r = simulate(cfg, sc, baseline=False)
        rows = {row["choice"]: row for row in r["review"][0]["rows"]}
        self.assertEqual(list(rows), ["mine", "ship", "edd", "slack", "spt", "no_actions", "auto"])
        self.assertEqual(rows["mine"]["spent"], 10)

    def test_validation_and_lock(self):
        cfg, sc = manual_mini()
        for bad in [{"day": 1, "policy": {"sub_assembly": "fast"}}, {"day": 1, "actions": {"X-SA1": "pray"}}, {"day": 0}]:
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                simulate({**cfg, "decisions": [bad]}, sc, baseline=False)
        with self.assertRaises(ConfigError):
            simulate({**cfg, "contingency": {"sub_assembly": 9999}}, sc, baseline=False)
        cfg2 = copy.deepcopy(cfg)
        cfg2["stations"]["block_assembly"]["dispatch_mode"] = "manual"   # 직접 대응 공정이 아니다
        with self.assertRaises(ConfigError):
            simulate(cfg2, sc, baseline=False)
        block = copy.deepcopy(load_presets("block")[1]["config"])
        block["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
        with self.assertRaises(ConfigError):
            simulate(block, baseline=False)

    def test_decisions_end_and_auto(self):
        cfg, sc = manual_mini()
        self.assertIsNone(simulate({**cfg, "decisions_end": True}, sc, baseline=False)["pending"])
        cfg["stations"]["sub_assembly"]["dispatch_mode"] = "auto"
        self.assertNotIn("pending", simulate(cfg, sc, baseline=False))


if __name__ == "__main__":
    unittest.main()
