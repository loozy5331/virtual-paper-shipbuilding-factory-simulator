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
from shipyard.sim import forecast

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

    def test_station_plan_late(self):
        # 4.49(사용자 "소조립도 +3이어야"): 소조립 공정 납기는 인계 기한이라, 실적서 지연 표는 계획 끝(plan)과 비교한 plan_late를 쓴다
        r = decide(preset("managed"), policy={"sub_assembly": "edd"})
        sa = {s["id"]: s["station_dues"]["sub_assembly"] for s in r["ships"]}
        self.assertEqual({k: (d["plan"], d["due"], d["plan_late"], d["late_days"]) for k, d in sa.items()},
                         {"A": (7, 10, 3, 0), "B": (8, 11, 3, 0), "C": (10, 12, 3, 1), "D": (8, 10, 2, 0), "E": (12, 13, 2, 1)})
        # 인계 기한이 없는 공정은 공정 납기가 곧 계획 끝
        ba = [s["station_dues"]["block_assembly"] for s in r["ships"]]
        self.assertTrue(all(d["plan"] == d["due"] and d["plan_late"] == d["late_days"] for d in ba), ba)

    def test_spt_misses_b(self):
        self.assertEqual(late(decide(preset("managed"), policy={"sub_assembly": "spt"})), {"B": 1})

    def test_actions_without_order(self):
        self.assertEqual(late(decide(preset("managed"), actions={"D-SA1": "extra"})), {"D": 1})
        r = decide(preset("managed"), actions={"C-SA1": "expedite"})
        self.assertEqual(late(r), {"D": 2})
        self.assertEqual(r["costs"]["emergency"], 120)
        # 납기 빠른 순에 C 긴급 조달을 더하면 C가 앞당겨져 뒤 공정에서 D를 밀어낸다(돈 쓰고 한 척 놓침)
        self.assertEqual(late(decide(preset("managed"), policy={"sub_assembly": "edd"}, actions={"C-SA1": "expedite"})), {"D": 1})


class Why(unittest.TestCase):
    """4.47(사용자 "D가 1일 지연된다는데 아래 간트로는 확인하기 어렵다"): 조치 요청 미리보기가 블록의 계획 끝과,
    계획보다 늦는 배마다 어디서 날을 더 썼는지 준다."""

    def card(self, **decision):
        cfg = preset("managed")
        cfg["decisions"] = [{"day": SCENE, **decision}]
        return forecast(cfg)["mine"]

    def test_plan_end_before_handoff(self):
        # D-208은 계획에서 8일에 끝난다. 인계 기한 10일까지 가면 이미 버퍼 2일(D 버퍼 전부)을 쓴 것
        b = self.card()["block_times"]["D-SA1"]
        self.assertEqual((b["plan_end"], b["due"]), (8, 10))

    def test_downstream_cause(self):
        # 납기 빠른 순에 C-115 철야: D-208은 그대로 10일에 끝나지만, C가 하루 일찍 내려와 D 중조립 블록이 운반을 하루 더 기다린다
        m = self.card(policy={"sub_assembly": "edd"}, actions={"C-SA1": "extra"})
        self.assertEqual(m["block_times"]["D-SA1"]["end"], 10)
        w = m["why"]["D"]
        self.assertEqual((w["plan_finish"], w["days"]), (14, 3))
        self.assertIn({"state": "transport_wait", "station": "block_assembly", "days": 2}, w["items"])
        self.assertEqual(sum(it["days"] for it in w["items"]), w["days"])   # 합 = 계획보다 늦은 날


class RootCause(unittest.TestCase):
    """4.48(D96, 사용자 "블록 지연에 대응하는 데서 끝나지 않고 근본 원인을 찾아 해결(여유 3일)"): 소조립 키트도 발주 방식을 따른다.
    키트의 날(kits)은 필요한 날 = 역산·여유 0일의 입고일. 여유 3일이면 사흘 지연을 흡수해 10일의 몰림이 없다."""

    def go(self, buffer=0, **decision):
        cfg = preset("managed")
        cfg["jit_buffer"] = buffer
        if decision:
            cfg["decisions"] = [{"day": SCENE, **decision}]
            cfg["decisions_end"] = True
        return simulate(cfg)

    def test_kits_follow_ordering(self):
        from shipyard.sim import kit_arrivals
        sc = load_scenario("dispatch")
        a = next(o for o in sc["orders"] if o["id"] == "A")
        cfg = preset("managed")
        self.assertEqual(kit_arrivals({**cfg, "ordering": "jit"}, sc, a), {"paint": 7})
        self.assertEqual(kit_arrivals({**cfg, "ordering": "jit", "jit_buffer": 3}, sc, a), {"paint": 4})
        self.assertEqual(kit_arrivals({**cfg, "ordering": "bulk"}, sc, a), {"paint": 6})    # 1일 발주 + 리드타임 5일
        self.assertEqual(kit_arrivals({**cfg, "ordering": "late"}, sc, a), {"paint": 12})   # 필요한 날 발주 + 5일

    def test_buffer_removes_scene(self):
        self.assertEqual(self.go()["pending"]["day"], SCENE)                 # 1회차: 10일에 몰린다
        r = self.go(3)
        self.assertIsNone(r.get("pending"))                                   # 여유 3일: 물을 날이 없다
        self.assertEqual(late(r), {})
        waits = lambda res: sum(1 for s in res["ships"] for d in s["daily"] if d["state"] == "material_wait" and d.get("station") == "sub_assembly")
        # 소조립 앞 자재 대기 16일 → 2일(계획이 키트가 일찍 온다고 보고 B·C 착수를 당겨 하루씩 남는다, 버퍼 안)
        self.assertEqual((waits(self.go()), waits(r)), (16, 2))

    def test_root_beats_symptom(self):
        # 근본 해결(여유 3일)이 증상 대응(10일에 납기 빠른 순)보다 점수가 높고, 여유일은 3일이 가장 좋다
        root, symptom = self.go(3), self.go(policy={"sub_assembly": "edd"})
        self.assertGreater(root["grade"]["score"], symptom["grade"]["score"])
        scores = [self.go(b)["grade"]["score"] for b in range(4)]
        self.assertEqual(max(range(4), key=lambda b: scores[b]), 3)
        # 여유는 공짜가 아니다: 키트가 한꺼번에 들어와 작업장 앞에서 기다리는 동안 재고비
        self.assertGreater(root["costs"]["holding"], self.go()["costs"]["holding"])


class Grade(unittest.TestCase):
    """등급 조율(D70의 예외, 조립 현장 배정처럼): B안은 조치 요청을 넘기면 D가 늦어 B, 납기 빠른 순이면 A, 가공·의장 3명씩이면 S."""

    def test_presets(self):
        grades = {p["id"]: simulate(p["config"])["grade"]["grade"] for p in load_presets("dispatch")}
        # 4.48(D96): A안(늦은 발주)은 키트도 늦게 발주되어(필요한 날 + 리드타임 5일 + 지연 3일) 다섯 척이 모두 늦는다(F)
        self.assertEqual(grades, {"unmanaged": "F", "managed": "B", "all_in": "B"})

    def test_root_tips_reach_s(self):
        # 4.48: 근본 해결 + 가공·의장 3명씩이면 조치 요청 없이 S
        cfg = preset("managed")
        cfg["pools"].update(processing=3, outfitting=3)
        cfg["jit_buffer"] = 3
        r = simulate(cfg)
        self.assertIsNone(r.get("pending"))
        self.assertEqual(r["grade"]["grade"], "S")

    def test_tips_reach_s(self):
        cfg = preset("managed")
        cfg["pools"].update(processing=3, outfitting=3)
        r = decide(cfg, policy={"sub_assembly": "edd"})
        self.assertEqual(late(r), {})
        self.assertGreaterEqual(r["grade"]["score"], 100)
        self.assertEqual(r["grade"]["grade"], "S")


if __name__ == "__main__":
    unittest.main()
