"""조립 현장 배정(4.30, D77) 검증. 규칙 문서 3장 "조립 작업 목록"과 10장 예시 11.

작업 목록은 생산계획서의 미리보기라 실행 결과를 바꾸지 않는다. 계산은 예시 9의 판(test_blocks.mini)으로 손 계산한다.
"""

import unittest

from shipyard import load_presets, load_scenario, preview, simulate

from tests.test_blocks import mini


class Example11(unittest.TestCase):
    """10장 예시 11: X 피더 혼자, 조립 6명(가용 48 MH), 소조립 블록 6 MH × 8, 중조립 블록 20 MH."""

    def setUp(self):
        cfg, sc = mini([("X", "FEEDER", 1, 40)])
        self.w = preview(cfg, sc)["worklist"]

    def test_day_one(self):
        # 1일: 소조립 8블록이 모두 들어갈 수 있다. 필요 48 MH = 가용 48 MH(부족 아님)
        d1 = self.w["days"]["1"]
        self.assertEqual((self.w["capacity_mh"], self.w["workers"], self.w["day_hours"]), (48, 6, 8))
        self.assertEqual((len(d1["rows"]), d1["need_mh"]), (8, 48))
        self.assertEqual({r["left_mh"] for r in d1["rows"]}, {6})

    def test_day_two_is_short(self):
        # 2일: X-SA1·2는 1일에 끝났다. X-SA3은 1일 6시간에 시작해 2시간 × 2명 = 4 MH를 했으니 2 MH 남는다.
        # 소조립 2 + 6 × 5 = 32, 짝(SA1·2)이 끝나 중조립 X-BA1(20 MH)이 들어온다: 52 > 48, 처음 모자라는 날 = focus
        d2 = self.w["days"]["2"]
        left = {r["id"]: r["left_mh"] for r in d2["rows"]}
        self.assertEqual((left["X-SA3"], left["X-SA4"], left["X-BA1"]), (2, 6, 20))
        self.assertNotIn("X-SA1", left)
        self.assertEqual((d2["need_mh"], self.w["focus"]), (52, 2))

    def test_downstream_mates(self):
        # 후행: X-SA3과 X-SA4가 X-BA2를 이룬다. 2일에는 SA4가 아직이라 짝이 끝나지 않았다
        row = next(r for r in self.w["days"]["2"]["rows"] if r["id"] == "X-SA3")
        self.assertEqual((row["next"], row["mates"], row["mates_done"]), ("X-BA2", ["X-SA4"], False))
        ga = next(r for d in self.w["days"].values() for r in d["rows"] if r["id"] == "X-GA2")
        self.assertEqual((ga["next"], ga["mates"]), ("erection", ["X-GA1"]))

    def test_rows_sorted_by_left_days(self):
        rows = self.w["days"]["2"]["rows"]
        self.assertEqual([r["left_days"] for r in rows], sorted(r["left_days"] for r in rows))


class AssemblyScenario(unittest.TestCase):
    def test_full_yard_after_assembly(self):
        # 블록 조립 실습과 달리 안벽의장·시운전까지 한다(도장·선행의장은 블록 공정 사이라 뺀다)
        sc = load_scenario("assembly")
        self.assertEqual(sc["skip"], ["painting", "pre_outfitting"])
        self.assertEqual(sc["station_material"], {"block_assembly": "paint"})
        r = simulate(load_presets("assembly")[1]["config"], baseline=False)
        self.assertTrue(all("sea_trial" in s["spans"] for s in r["ships"]))

    def test_material_column(self):
        # 중조립은 물감 키트를 쓴다: 작업 목록의 자재 칸은 계획 입고일(발주일 + 리드타임), 그날 전에 들어오면 준비
        w = preview(load_presets("assembly")[1]["config"])["worklist"]
        rows = [r for d in w["days"].values() for r in d["rows"] if r["station"] == "block_assembly"]
        self.assertTrue(rows and all(r["material"] == "paint" and r["kit_day"] for r in rows))
        self.assertTrue(all(r["material"] is None for d in w["days"].values() for r in d["rows"] if r["station"] == "sub_assembly"))

    def test_preview_does_not_change_result(self):
        cfg = load_presets("assembly")[1]["config"]
        a = simulate(cfg, baseline=False)
        preview(cfg)
        self.assertEqual(a["profit"], simulate(cfg, baseline=False)["profit"])


if __name__ == "__main__":
    unittest.main()
