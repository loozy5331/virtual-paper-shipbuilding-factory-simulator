"""수업용 저장소(server/store.py) 확인.

    python -m unittest discover -s server/tests -t server
"""

import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "server"))

from shipyard import load_presets, simulate  # noqa: E402
from store import Store, StoreError  # noqa: E402

BASIC = {p["id"]: p["config"] for p in load_presets("basic")}
GROWTH = {p["id"]: p["config"] for p in load_presets("growth")}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.dir.name) / "t.sqlite3", simulate, "test")

    def tearDown(self):
        self.dir.cleanup()

    def save(self, nickname, cfg, code="3반"):
        return self.store.save_run({"nickname": nickname, "class_code": code, "config": cfg})

    def test_grade_is_recomputed_on_the_server(self):
        # 화면이 등급을 보내도 무시하고 설정으로 다시 계산한다.
        saved = self.store.save_run({"nickname": "Bell", "class_code": "3반", "config": BASIC["managed"], "grade": "S", "score": 112})
        self.assertEqual((saved["grade"], saved["score"]), ("A", 88.4))   # 관리안(4.3.0 값, D40)

    def test_leaderboard_takes_the_best_per_scenario_and_class(self):
        self.save("Bell", BASIC["unmanaged"])
        self.save("Loozy", BASIC["managed"])
        self.save("Bell", GROWTH["managed"])
        self.save("Other", BASIC["managed"], code="4반")
        board = self.store.leaderboard("3반")["best"]
        self.assertEqual((board["basic"]["nickname"], board["basic"]["grade"], board["basic"]["players"]), ("Loozy", "A", 2))   # 관리안(A)이 무관리(F)보다 높다
        self.assertEqual(board["growth"]["nickname"], "Bell")
        self.assertEqual(self.store.leaderboard("4반")["best"]["basic"]["players"], 1)

    def test_same_nickname_and_class_is_one_user(self):
        self.save("Bell", BASIC["managed"])
        self.save("Bell", BASIC["all_in"])
        self.assertEqual(self.store.leaderboard("3반")["best"]["basic"]["players"], 1)

    def test_empty_class_code_saves_but_has_no_board(self):
        self.save("Bell", BASIC["managed"], code="")
        self.assertEqual(self.store.leaderboard("")["best"], {})

    def test_bad_input_is_rejected(self):
        with self.assertRaises(StoreError):
            self.save("", BASIC["managed"])
        with self.assertRaises(StoreError):
            self.save("가나다라마바사아자차카", BASIC["managed"])   # 11자
        with self.assertRaises(StoreError):
            self.save("Bell", BASIC["managed"], code="3반; DROP TABLE")
        cfg = copy.deepcopy(BASIC["managed"])
        cfg["pools"]["assembly"] = 99
        from shipyard import ConfigError
        with self.assertRaises(ConfigError):
            self.save("Bell", cfg)


if __name__ == "__main__":
    unittest.main()
