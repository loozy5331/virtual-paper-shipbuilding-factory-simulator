"""작업 배정 실습(4.43, D91): 수업 주제 07 슬라이드의 현장에서 시작하는 실습. 규칙 문서 3장 블록 조립의 "작업 배정".

1일 아침 중조립 작업장 앞에 다섯 척의 블록이 하나씩 와 있다(슬라이드 표 그대로):
    블록    남은 기간  필요 작업시간  자재
    A-101   1일        16시간         완료
    B-203   2일        24시간         완료
    C-115   3일        12시간         미완료(3일 입고)
    D-208   1일         8시간         완료
    E-320   4일        20시간         완료
조립 5명 = 가용 40시간, 필요 80시간.
"""

import copy
import unittest

from shipyard import load_presets, load_scenario, simulate


def preset(pid):
    return copy.deepcopy(next(p for p in load_presets("dispatch") if p["id"] == pid)["config"])


def decide(cfg, day=1, **decision):
    cfg = copy.deepcopy(cfg)
    cfg["decisions"] = [{"day": day, **decision}]
    cfg["decisions_end"] = True
    return simulate(cfg)


def late(result):
    return {s["id"]: s["late_days"] for s in result["ships"] if s["late_days"]}


class Scene(unittest.TestCase):
    """1일 아침 조치 요청이 슬라이드 표와 같다."""

    @classmethod
    def setUpClass(cls):
        cls.r = simulate(preset("managed"), baseline=False)
        cls.sit = cls.r["pending"]

    def test_asks_on_day_one(self):
        self.assertEqual(self.sit["day"], 1)
        self.assertEqual((self.sit["capacity_mh"], self.sit["need_mh"]), (40, 80))
        self.assertNotIn("ships", self.sit)   # 버퍼 없는 카드(작업장 앞 n건 · 가용 / 필요)

    def test_table(self):
        rows = {w["id"]: w for w in self.sit["stations"]["block_assembly"]["waiting"]}
        self.assertEqual({bid: (w["left_days"], w["mh"]) for bid, w in rows.items()},
                         {"A-BA1": (1, 16), "B-BA1": (2, 24), "C-BA1": (3, 12), "D-BA1": (1, 8), "E-BA1": (4, 20)})
        self.assertEqual({bid: w["kit"]["state"] for bid, w in rows.items()},
                         {"A-BA1": "ready", "B-BA1": "ready", "C-BA1": "coming", "D-BA1": "ready", "E-BA1": "ready"})
        self.assertEqual(rows["C-BA1"]["kit"]["arrival_day"], 3)
        self.assertTrue(all(w["next"] == "erection" for w in rows.values()))   # 다음 공정 = 탑재

    def test_names(self):
        sc = load_scenario("dispatch")
        self.assertEqual(sc["block_names"], {"A-BA1": "A-101", "B-BA1": "B-203", "C-BA1": "C-115", "D-BA1": "D-208", "E-BA1": "E-320"})
        self.assertEqual(sc["blocks"]["block_assembly"], 1)
        self.assertEqual(sc["blocks"]["sub_assembly"], 8)   # 공통 값은 그대로

    def test_start_fixed(self):
        cfg = preset("managed")
        cfg["ships"]["E"]["start_day"] = 4
        r = simulate(cfg, baseline=False)
        self.assertEqual({s["id"]: s["start_day"] for s in r["ships"]}, dict.fromkeys("ABCDE", 1))


class Order(unittest.TestCase):
    """순서가 결과를 가른다: 남은 기간 짧은 순(납기 빠른 순)만 다섯 척을 지킨다."""

    def test_keep_ship_order_misses_d(self):
        r = decide(preset("managed"))
        self.assertEqual(late(r), {"D": 1})
        self.assertEqual(r["grade"]["grade"], "B")   # 납기 상한(4.33)

    def test_edd_keeps_all(self):
        r = decide(preset("managed"), policy={"block_assembly": "edd"})
        self.assertEqual(late(r), {})
        self.assertEqual(r["grade"]["grade"], "A")
        done = {b["id"]: b["done_day"] for b in r["blocks"]}
        self.assertEqual(done, {"A-BA1": 1, "D-BA1": 1, "B-BA1": 2, "C-BA1": 3, "E-BA1": 3})

    def test_spt_misses_b(self):
        self.assertEqual(late(decide(preset("managed"), policy={"block_assembly": "spt"})), {"B": 1})

    def test_actions_without_order_do_not_save_d(self):
        # 선박 순서 그대로면 D는 2일에야 정반에 오른다. B 응원이나 C 긴급 조달로는 살리지 못한다
        self.assertEqual(late(decide(preset("managed"), actions={"B-BA1": "assist"})), {"D": 1})
        self.assertEqual(late(decide(preset("managed"), actions={"C-BA1": "expedite"})), {"D": 2})

    def test_c_waits_for_kit(self):
        r = decide(preset("managed"), policy={"block_assembly": "edd"})
        c = next(b for b in r["blocks"] if b["id"] == "C-BA1")
        self.assertEqual(c["start"], 3)   # 키트가 3일에 들어와야 정반에 오른다


class Grade(unittest.TestCase):
    """등급 조율(D70의 예외, 조립 현장 배정처럼): B안은 조치 요청을 넘기면 D가 늦어 B, 팁을 반영하면 S."""

    def test_presets(self):
        grades = {p["id"]: simulate(p["config"])["grade"]["grade"] for p in load_presets("dispatch")}
        self.assertEqual(grades, {"unmanaged": "B", "managed": "B", "all_in": "B"})

    def test_tips_reach_s(self):
        cfg = preset("managed")
        cfg["stations"]["block_assembly"]["units"] = 1
        r = decide(cfg, policy={"block_assembly": "edd"}, actions={"A-BA1": "assist", "B-BA1": "assist"})
        self.assertEqual(late(r), {})
        self.assertGreaterEqual(r["grade"]["score"], 100)
        self.assertEqual(r["grade"]["grade"], "S")


if __name__ == "__main__":
    unittest.main()
