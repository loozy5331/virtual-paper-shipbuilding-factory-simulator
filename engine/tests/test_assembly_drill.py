"""조립 현장 배정(4.30, D77)과 몰리는 날의 결정(4.31, D78) 검증. 규칙 문서 3장 "몰리는 날의 결정"과 10장 예시 11.

결정은 예시 9의 판(test_blocks.mini)으로 손 계산한다. 실습 판(assembly)은 등급 조율(D70)과 결정 지점만 본다.
"""

import copy
import unittest

from shipyard import ConfigError, load_presets, load_scenario, simulate

from tests.test_blocks import mini

ASM = ("sub_assembly", "block_assembly", "grand_assembly")


def manual_mini():
    """예시 9의 판(X 피더 1순위, Y 예인선 2순위, 소조립 작업장 1곳, 조립 6명 = 가용 48 MH)에서 소조립을 직접 대응으로."""
    cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
    sc["options"] = {"crews": ["normal"], "methods": ["standard"], "material_grades": ["standard"], "max_units": 2,
                     "split": False, "decisions": True}
    cfg["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
    return cfg, sc


def done_days(result, ship):
    return [b["done_day"] for b in result["blocks"] if b["ship"] == ship and b["station"] == "sub_assembly"]


def play(cfg, choose):
    """결정 기록을 비워 두고 처음 묻는 날마다 choose(situation)로 정하며 끝까지(화면이 하는 일)."""
    cfg = copy.deepcopy(cfg)
    cfg["decisions"] = []
    while True:
        r = simulate(cfg, baseline=False)
        if not r["pending"]:
            return cfg, r
        pd = r["pending"]
        cfg["decisions"].append({"day": pd["day"], "orders": choose(pd)})


class Example11(unittest.TestCase):
    """10장 예시 11: 1일에 X 소조립 8블록(6 MH씩 48)과 Y 8블록(4 MH씩 32)이 함께 기다린다. 80 MH > 가용 48 MH, 두 척 → 묻는다."""

    def test_pending_on_crunch_day(self):
        cfg, sc = manual_mini()
        r = simulate(cfg, sc, baseline=False)
        pd = r["pending"]
        self.assertEqual((pd["day"], pd["need_mh"], pd["capacity_mh"]), (1, 80, 48))
        st = pd["stations"]["sub_assembly"]
        self.assertEqual(len(st["waiting"]), 16)
        self.assertEqual(st["rule_orders"]["spt"][:2], ["Y-SA1", "Y-SA2"])   # 작업 짧은 순: Y 블록(0.5)이 X(0.75)보다 먼저
        # 묻는 동안은 기본 대응(선박 순서)으로 끝까지 돈다: 예시 9와 같다
        self.assertEqual(done_days(r, "X"), [1, 1, 2, 2, 2, 3, 3, 3])

    def test_decision_reorders(self):
        # Y를 먼저: 하루 처리량 2로 Y 블록(0.5) 4개씩 1·2일, X 블록(0.75)은 3일부터 3·3·4·4·4·5·5·5
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "orders": {"sub_assembly": [f"Y-SA{k}" for k in range(1, 9)] + [f"X-SA{k}" for k in range(1, 9)]}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertIsNone(r["pending"])
        self.assertEqual(done_days(r, "Y"), [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(done_days(r, "X"), [3, 3, 4, 4, 4, 5, 5, 5])
        self.assertEqual([d["day"] for d in r["decisions"]], [1])

    def test_review_compares_rules(self):
        # 끝난 회차: 결정마다 내 선택 + 규칙 넷 + 기본 대응. 선박 순서는 예시 9와 같은 결과
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "orders": {"sub_assembly": [f"Y-SA{k}" for k in range(1, 9)]}}]
        r = simulate(cfg, sc, baseline=False)
        rows = {row["choice"]: row for row in r["review"][0]["rows"]}
        self.assertEqual(list(rows), ["mine", "ship", "edd", "slack", "spt", "auto"])
        self.assertEqual(rows["ship"]["on_time"], rows["auto"]["on_time"])

    def test_decisions_end_stops_asking(self):
        cfg, sc = manual_mini()
        cfg["decisions_end"] = True
        self.assertIsNone(simulate(cfg, sc, baseline=False)["pending"])

    def test_auto_never_asks(self):
        cfg, sc = manual_mini()
        cfg["stations"]["sub_assembly"]["dispatch_mode"] = "auto"
        self.assertNotIn("pending", simulate(cfg, sc, baseline=False))

    def test_validation_and_lock(self):
        cfg, sc = manual_mini()
        for bad in [{"day": 1, "orders": {"sub_assembly": ["Z-SA1"]}}, {"day": 0, "orders": {}}, {"orders": {}}]:
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                simulate({**cfg, "decisions": [bad]}, sc, baseline=False)
        cfg2 = copy.deepcopy(cfg)
        cfg2["stations"]["erection"]["dispatch_mode"] = "manual"
        with self.assertRaises(ConfigError):
            simulate(cfg2, sc, baseline=False)
        # 블록 조립 실습(block)은 직접 대응을 열지 않았다
        block = copy.deepcopy(load_presets("block")[1]["config"])
        block["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
        with self.assertRaises(ConfigError):
            simulate(block, baseline=False)


class AssemblyScenario(unittest.TestCase):
    def test_full_yard_after_assembly(self):
        # 블록 조립 실습과 달리 안벽의장·시운전까지 한다(도장·선행의장은 블록 공정 사이라 뺀다)
        sc = load_scenario("assembly")
        self.assertEqual(sc["skip"], ["painting", "pre_outfitting"])
        self.assertEqual(sc["station_material"], {"block_assembly": "paint"})
        r = simulate(load_presets("assembly")[1]["config"], baseline=False)
        self.assertTrue(all("sea_trial" in s["spans"] for s in r["ships"]))

    def test_crunch_days(self):
        # B안(조립 세 공정 직접 대응)을 납기 빠른 순으로 답하면 8·9·12·14일에 묻는다(새 배의 블록이 대기열에 끼어드는 몰리는 날)
        cfg = load_presets("assembly")[1]["config"]
        self.assertEqual({cfg["stations"][s]["dispatch_mode"] for s in ASM}, {"manual"})
        _, r = play(cfg, lambda pd: {s: v["rule_orders"]["edd"] for s, v in pd["stations"].items() if v["manual"] and v["waiting"]})
        self.assertEqual([d["day"] for d in r["decisions"]], [8, 9, 12, 14])


class AssemblyGrade(unittest.TestCase):
    """등급 조율(D70, 4.30): B안은 A, B안에 선배의 팁(안벽의장 1명·가공 1명)을 반영하면 S."""

    def test_presets(self):
        # B안은 직접 대응이라 첫 물음(8일)에서 멈추고, 묻는 동안의 결과는 기본 대응(이후 묻지 않음)과 같다
        presets = {p["id"]: p["config"] for p in load_presets("assembly")}
        cases = {"unmanaged": (44.5, "F", 1), "managed": (89.1, "A", 3), "all_in": (59.4, "C", 3)}
        for pid, want in cases.items():
            r = simulate(presets[pid])
            self.assertEqual((r["grade"]["score"], r["grade"]["grade"], r["qcd"]["delivery"]["on_time"]), want, pid)
        self.assertEqual(simulate(presets["managed"])["pending"]["day"], 8)
        self.assertEqual(presets["managed"]["pools"]["assembly"], 5)   # 하루 40 MH(슬라이드의 당일 가용 작업시간)

    def test_tips_reach_s(self):
        tips = copy.deepcopy(load_presets("assembly")[1]["config"])
        tips["pools"].update({"outfitting": 1, "processing": 1})
        tips["decisions_end"] = True
        r = simulate(tips)
        self.assertEqual((r["grade"]["grade"], r["qcd"]["delivery"]["on_time"]), ("S", 3))

    def test_answers_deadline_vs_work_time(self):
        # 슬라이드의 질문 "납기와 작업시간 중 무엇을 먼저": 몰리는 날마다 작업 짧은 순으로 답하면 S1이 3일 늦고(B),
        # 돌아보기는 결정마다 다른 순서였다면 3척 모두 지켰다고 알려 준다. 납기 빠른 순으로 답하면 A
        def by(rule):
            return lambda pd: {s: v["rule_orders"][rule] for s, v in pd["stations"].items() if v["manual"] and v["waiting"]}
        cfg = load_presets("assembly")[1]["config"]
        _, spt = play(cfg, by("spt"))
        self.assertEqual(({s["id"]: s["late_days"] for s in spt["ships"]}["S1"], spt["qcd"]["delivery"]["on_time"]), (3, 2))
        cfg_spt, _ = play(cfg, by("spt"))
        review = simulate(cfg_spt)["review"]
        self.assertTrue(all(not rv["mine_is_best"] for rv in review[:4]))
        self.assertTrue(all(max(row["on_time"] for row in rv["rows"]) == 3 for rv in review[:4]))
        cfg_edd, _ = play(cfg, by("edd"))
        self.assertEqual(simulate(cfg_edd)["grade"]["grade"], "A")

    def test_rules_recommend(self):
        rec = simulate(load_presets("assembly")[1]["config"])["recommend"]
        self.assertEqual(rec["best"], "edd")


if __name__ == "__main__":
    unittest.main()
