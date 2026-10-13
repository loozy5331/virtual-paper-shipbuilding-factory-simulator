"""기준선 캐시(4.16.2): 채점 결과는 캐시가 없을 때와 같고, 설정이 바뀌면 새로 계산한다.

    python -m unittest discover -s engine/tests -t engine
"""

import copy
import unittest
from unittest import mock

from shipyard import load_presets, load_scenario, simulate
from shipyard import sim
from shipyard.sim import clear_baseline_cache

MANAGED = next(p for p in load_presets() if p["id"] == "managed")["config"]


def runs(fn):
    """fn을 하는 동안 하루 틱 루프(_run)를 몇 번 돌렸는지 센다. 발주 방식을 풀 때의 탐색 실행도 센다."""
    real = sim._run
    count = 0

    def counting(config, scenario):
        nonlocal count
        count += 1
        return real(config, scenario)

    with mock.patch.object(sim, "_run", counting):
        fn()
    return count


def student_runs(cfg, scenario=None):
    """기준선 없이 학생 계획만 돌릴 때의 실행 수."""
    return runs(lambda: simulate(cfg, scenario, baseline=False))


class BaselineCache(unittest.TestCase):
    def setUp(self):
        clear_baseline_cache()

    def test_same_grade_as_without_cache(self):
        """캐시에서 꺼낸 기준선도 처음 계산한 것과 같다."""
        first = simulate(MANAGED)["grade"]
        second = simulate(MANAGED)["grade"]
        self.assertEqual(first, second)
        clear_baseline_cache()
        self.assertEqual(simulate(MANAGED)["grade"], first)

    def test_second_grade_skips_baseline_run(self):
        self.assertGreater(runs(lambda: simulate(MANAGED)), student_runs(MANAGED))
        self.assertEqual(runs(lambda: simulate(MANAGED)), student_runs(MANAGED))

    def test_each_scenario_has_its_own_baseline(self):
        """분기가 다르면 기준선도 다르다."""
        growth = next(p for p in load_presets("growth") if p["id"] == "managed")["config"]
        a = simulate(MANAGED)["grade"]["baseline"]
        b = simulate(growth)["grade"]["baseline"]
        self.assertNotEqual(a, b)
        self.assertEqual(simulate(MANAGED)["grade"]["baseline"], a)

    def test_changed_rule_number_recomputes(self):
        """rules.json·시나리오 파일의 숫자가 바뀌면(바뀐 시나리오를 넘기면) 기준선을 새로 돌린다."""
        before = simulate(MANAGED)["grade"]["baseline"]
        sc = load_scenario()
        sc["rules"]["costs"]["wage_per_day"] += 5
        self.assertGreater(runs(lambda: simulate(MANAGED, sc)), student_runs(MANAGED, sc))
        after = simulate(MANAGED, sc)["grade"]["baseline"]
        self.assertNotEqual(after["profit"], before["profit"])

    def test_changed_random_table_recomputes(self):
        sc = load_scenario()
        sc["random"]["breakdown"] = {k: [0.0] * len(v) for k, v in sc["random"]["breakdown"].items()}
        before = simulate(MANAGED)["grade"]["baseline"]
        after = simulate(MANAGED, sc)["grade"]["baseline"]
        self.assertNotEqual(after, before)

    def test_changed_baseline_preset_recomputes(self):
        """프리셋(기준선 설정)이 바뀌면 키가 달라진다."""
        sc = load_scenario()
        presets = copy.deepcopy(load_presets())
        base = next(p for p in presets if p["id"] == sc["grade"]["baseline_preset"])
        simulate(MANAGED)
        base["config"]["pools"]["assembly"] -= 1
        with mock.patch.object(sim, "load_presets", lambda _sid="basic": presets):
            self.assertGreater(runs(lambda: simulate(MANAGED)), student_runs(MANAGED))

    def test_caller_cannot_change_cached_value(self):
        """결과를 고쳐도 다음 채점에 새지 않는다."""
        g = simulate(MANAGED)["grade"]
        g["baseline"]["score"] = -1
        self.assertNotEqual(simulate(MANAGED)["grade"]["baseline"]["score"], -1)

    def test_cache_size_is_bounded(self):
        for k in range(sim._BASELINE_CACHE_SIZE + 5):
            sc = load_scenario()
            sc["rules"]["costs"]["wage_per_day"] += k
            simulate(MANAGED, sc)
        self.assertEqual(len(sim._BASELINE_CACHE), sim._BASELINE_CACHE_SIZE)


if __name__ == "__main__":
    unittest.main()
