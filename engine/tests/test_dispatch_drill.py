"""작업 배정 실습(4.43, D91): 수업 주제 07 슬라이드의 현장이 실행 중에 한 번 나오는 실습. 규칙 문서 3장 블록 조립의 "작업 배정".

조립 현장 배정과 같은 여덟 공정(절단·가공·소조립·중조립·PE장·탑재·안벽의장·시운전, 4.45)으로 다섯 척을 만든다. 소조립 보강재 키트가 사흘 늦어(입고 지연)
10일 아침 소조립 작업장 앞에 다섯 블록이 한꺼번에 선다(슬라이드 표 그대로):
    블록    남은 기간  필요 작업시간  자재
    A-101   1일        16시간         완료
    B-203   2일        24시간         완료
    C-115   3일        12시간         미완료(12일 입고)
    D-208   1일         8시간         완료
    E-320   4일        20시간         완료
조립 5명 = 가용 40시간, 필요 80시간. 배마다 버퍼(B안 A 3 · B 3 · C 3 · D 2 · E 3일)가 있다.
"""

import copy
import unittest

from shipyard import load_presets, load_scenario, simulate

SCENE = 10


def preset(pid):
    return copy.deepcopy(next(p for p in load_presets("dispatch") if p["id"] == pid)["config"])


def decide(cfg, **decision):
    cfg = copy.deepcopy(cfg)
    cfg["decisions"] = [{"day": SCENE, **decision}]
    cfg["decisions_end"] = True
    return simulate(cfg)


def late(result):
    return {s["id"]: s["late_days"] for s in result["ships"] if s["late_days"]}


class Scene(unittest.TestCase):
    """10일 아침 조치 요청이 슬라이드 표와 같고, 실행 중 한 번만 뜬다."""

    @classmethod
    def setUpClass(cls):
        cls.r = simulate(preset("managed"), baseline=False)
        cls.sit = cls.r["pending"]

    def test_asks_once_on_day_ten(self):
        self.assertEqual(self.sit["day"], SCENE)
        self.assertEqual((self.sit["capacity_mh"], self.sit["need_mh"]), (40, 80))
        st = self.sit["stations"]
        self.assertEqual(st["sub_assembly"]["inside"], [])
        for later in ("block_assembly", "grand_assembly"):
            self.assertEqual(st[later]["waiting"] + st[later]["inside"], [])
        # 지금대로(그날 항목만 적고 더 묻게 둔다) 끝까지 가도 다시 묻지 않는다
        cfg = preset("managed")
        cfg["decisions"] = [{"day": SCENE}]
        self.assertIsNone(simulate(cfg, baseline=False)["pending"])

    def test_table(self):
        rows = {w["id"]: w for w in self.sit["stations"]["sub_assembly"]["waiting"]}
        self.assertEqual({bid: (w["left_days"], w["mh"]) for bid, w in rows.items()},
                         {"A-SA1": (1, 16), "B-SA1": (2, 24), "C-SA1": (3, 12), "D-SA1": (1, 8), "E-SA1": (4, 20)})
        self.assertEqual({bid: w["kit"]["state"] for bid, w in rows.items()},
                         {"A-SA1": "ready", "B-SA1": "ready", "C-SA1": "coming", "D-SA1": "ready", "E-SA1": "ready"})
        self.assertEqual((rows["C-SA1"]["kit"]["arrival_day"], rows["C-SA1"]["kit"]["delayed"]), (12, True))
        self.assertTrue(all(w["next"].endswith("BA1") for w in rows.values()))   # 다음 공정 = 중조립
        # 묻는 까닭: 지금 순서(선박 순서)면 D-208이 인계 기한을 하루 넘겨 D가 버퍼를 쓸 것 같다
        self.assertEqual(self.sit["ships"]["D"]["use"], 1)

    def test_scenario(self):
        sc = load_scenario("dispatch")
        self.assertEqual([st["id"] for st in sc["stations"] if not st.get("skipped")],
                         ["cutting", "processing", "sub_assembly", "block_assembly", "grand_assembly", "erection", "quay_outfitting",
                          "sea_trial"])   # 조립 현장 배정과 같다(도장·선행의장은 블록 공정 사이라 뺀다)
        self.assertEqual(sc["block_names"]["C-SA1"], "C-115")
        self.assertEqual((sc["blocks"]["sub_assembly"], sc["blocks"]["block_assembly"], sc["blocks"]["grand_assembly"],
                          sc["blocks"]["painting"]), (1, 1, 1, 4))

    def test_kits_go_to_station(self):
        # 미리 발주해 둔 키트는 창고를 거치지 않고 소조립에 바로(지게차 일감이 아니다), 지연은 원래 입고일에 알린다
        ev = [e for e in self.r["events"] if e["type"] in ("arrival", "supply_delay") and e.get("material") == "paint"]
        self.assertEqual(sorted((e["day"], e["type"], e["ship"]) for e in ev),
                         [(7, "supply_delay", s) for s in "ABDE"] + [(9, "supply_delay", "C")]
                         + [(10, "arrival", s) for s in "ABDE"] + [(12, "arrival", "C")])
        self.assertTrue(all(e.get("direct") for e in ev if e["type"] == "arrival"))


class Order(unittest.TestCase):
    """순서가 결과를 가른다. 키트 지연으로 모든 배가 소조립에서 버퍼를 쓰지만, 남은 기간 짧은 순이면 버퍼가 덮는다."""

    def test_keep_ship_order_misses_d(self):
        r = decide(preset("managed"))
        self.assertEqual(late(r), {"D": 1})
        self.assertEqual(r["grade"]["grade"], "B")   # 납기 상한(4.33)

    def test_edd_buffer_covers(self):
        r = decide(preset("managed"), policy={"sub_assembly": "edd"})
        self.assertEqual(late(r), {})
        self.assertEqual(r["grade"]["grade"], "A")
        # 소조립에서 C-115·E-320은 인계 기한을 하루 넘기지만(버퍼 소모) 배는 납기 안. E는 뒤 공정에서 하루를 되찾는다
        sa = {b["id"]: (b["done_day"], b["due"]) for b in r["blocks"] if b["station"] == "sub_assembly"}
        self.assertEqual(sa, {"A-SA1": (10, 10), "D-SA1": (10, 10), "B-SA1": (11, 11), "C-SA1": (13, 12), "E-SA1": (14, 13)})
        self.assertEqual({s["id"]: s["due_day"] - s["completed_day"] for s in r["ships"]}, {"A": 0, "B": 0, "C": 0, "D": 0, "E": 1})
        # 배마다 버퍼를 썼다(목표 완료 = 납기 − 버퍼보다 늦게 끝남). 그래도 납기 안
        buf = preset("managed")["ships"]
        used = {s["id"]: s["completed_day"] - (s["due_day"] - buf[s["id"]]["buffer"]) for s in r["ships"]}
        self.assertTrue(all(v > 0 for v in used.values()), used)

    def test_spt_misses_b(self):
        self.assertEqual(late(decide(preset("managed"), policy={"sub_assembly": "spt"})), {"B": 1})

    def test_actions_without_order(self):
        self.assertEqual(late(decide(preset("managed"), actions={"D-SA1": "extra"})), {"D": 1})
        r = decide(preset("managed"), actions={"C-SA1": "expedite"})
        self.assertEqual(late(r), {"D": 2})
        self.assertEqual(r["costs"]["emergency"], 120)
        # 납기 빠른 순에 C 긴급 조달을 더하면 C가 앞당겨져 뒤 공정에서 D를 밀어낸다(돈 쓰고 한 척 놓침)
        self.assertEqual(late(decide(preset("managed"), policy={"sub_assembly": "edd"}, actions={"C-SA1": "expedite"})), {"D": 1})


class Grade(unittest.TestCase):
    """등급 조율(D70의 예외, 조립 현장 배정처럼): B안은 조치 요청을 넘기면 D가 늦어 B, 납기 빠른 순이면 A, 가공·의장 3명씩이면 S."""

    def test_presets(self):
        grades = {p["id"]: simulate(p["config"])["grade"]["grade"] for p in load_presets("dispatch")}
        self.assertEqual(grades, {"unmanaged": "C", "managed": "B", "all_in": "B"})

    def test_tips_reach_s(self):
        cfg = preset("managed")
        cfg["pools"].update(processing=3, outfitting=3)
        r = decide(cfg, policy={"sub_assembly": "edd"})
        self.assertEqual(late(r), {})
        self.assertGreaterEqual(r["grade"]["score"], 100)
        self.assertEqual(r["grade"]["grade"], "S")


if __name__ == "__main__":
    unittest.main()
