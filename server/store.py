"""수업용 저장소(2.0 ⑤): 닉네임 + 반 코드로 회차를 저장하고 반별 최고 등급을 낸다.

표준 라이브러리 sqlite3만 쓴다. 표는 처음부터 셋으로 나눈다(D8).
    users  닉네임과 반 코드. 같은 반에 같은 닉네임이면 같은 사람으로 본다(로그인이 없는 수업용).
    auth   비어 있다. 나중에 로그인을 붙일 때 users에 연결한다.
    runs   60일을 끝낸 회차: 시나리오, 설정, 등급·점수·이익.

등급은 화면이 보낸 값을 믿지 않고 설정으로 엔진을 다시 돌려 계산한다. 숫자를 고쳐 보내도 순위가 흔들리지 않는다.
요청마다 연결을 새로 열어 ThreadingHTTPServer의 여러 스레드에서도 안전하게 쓴다.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

NICKNAME_MAX = 10
CLASS_CODE_MAX = 20
# 반 코드: 한글, 영문, 숫자, -, _ 만. 비워 두면 반 순위에 들어가지 않는다.
CLASS_CODE_RE = re.compile(r"^[0-9A-Za-z가-힣_-]*$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    nickname    TEXT NOT NULL,
    class_code  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (nickname, class_code)
);
CREATE TABLE IF NOT EXISTS auth (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    provider    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    scenario    TEXT NOT NULL,
    config      TEXT NOT NULL,
    grade       TEXT NOT NULL,
    score       REAL NOT NULL,
    profit      REAL NOT NULL,
    on_time     INTEGER NOT NULL,
    ships       INTEGER NOT NULL,
    version     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_scenario ON runs (scenario, score DESC);
"""


class StoreError(ValueError):
    """잘못된 닉네임이나 반 코드. 메시지는 화면에 그대로 보여 준다."""

    def __init__(self, messages: list[str]):
        super().__init__("; ".join(messages))
        self.messages = messages


def clean_nickname(value: Any) -> str:
    nickname = str(value or "").strip()
    if not nickname:
        raise StoreError(["닉네임을 적어 주세요"])
    if len(nickname) > NICKNAME_MAX:
        raise StoreError([f"닉네임은 {NICKNAME_MAX}자까지입니다"])
    if any(ord(ch) < 32 for ch in nickname):
        raise StoreError(["닉네임에 쓸 수 없는 글자가 있습니다"])
    return nickname


def clean_class_code(value: Any) -> str:
    code = str(value or "").strip()
    if len(code) > CLASS_CODE_MAX or not CLASS_CODE_RE.match(code):
        raise StoreError([f"반 코드는 한글·영문·숫자·-·_ 로 {CLASS_CODE_MAX}자까지입니다"])
    return code


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path, simulate: Callable[[dict], dict], version: str):
        self.path = path
        self.simulate = simulate
        self.version = version
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def _user_id(self, db: sqlite3.Connection, nickname: str, class_code: str) -> int:
        row = db.execute("SELECT id FROM users WHERE nickname = ? AND class_code = ?", (nickname, class_code)).fetchone()
        if row:
            return row["id"]
        return db.execute("INSERT INTO users (nickname, class_code, created_at) VALUES (?, ?, ?)",
                          (nickname, class_code, _now())).lastrowid

    def save_run(self, payload: dict) -> dict:
        """회차를 저장한다. 설정으로 엔진을 다시 돌려 등급을 계산한다(ConfigError는 그대로 올린다)."""
        nickname = clean_nickname(payload.get("nickname"))
        class_code = clean_class_code(payload.get("class_code"))
        config = payload.get("config")
        if not isinstance(config, dict):
            raise StoreError(["설정이 없습니다"])
        result = self.simulate(config)
        grade = result["grade"]
        scenario = config.get("scenario", "basic")
        with self._connect() as db:
            user_id = self._user_id(db, nickname, class_code)
            run_id = db.execute(
                "INSERT INTO runs (user_id, scenario, config, grade, score, profit, on_time, ships, version, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, scenario, json.dumps(config, ensure_ascii=False), grade["grade"], grade["score"],
                 result["profit"], result["qcd"]["delivery"]["on_time"], len(result["ships"]), self.version, _now()),
            ).lastrowid
        return {"id": run_id, "nickname": nickname, "class_code": class_code, "scenario": scenario,
                "grade": grade["grade"], "score": grade["score"], "profit": result["profit"]}

    def leaderboard(self, class_code: Any) -> dict:
        """반 코드의 시나리오별 최고 회차(점수, 같으면 이익, 같으면 먼저 저장한 회차). 반 코드가 비면 빈 표."""
        code = clean_class_code(class_code)
        best: dict[str, dict] = {}
        if not code:
            return {"class_code": code, "best": best}
        with self._connect() as db:
            rows = db.execute(
                "SELECT r.scenario, r.grade, r.score, r.profit, r.on_time, r.ships, r.created_at, u.nickname"
                " FROM runs r JOIN users u ON u.id = r.user_id WHERE u.class_code = ?"
                " ORDER BY r.scenario, r.score DESC, r.profit DESC, r.id ASC", (code,)).fetchall()
            players = db.execute(
                "SELECT r.scenario, COUNT(DISTINCT r.user_id) AS n FROM runs r JOIN users u ON u.id = r.user_id"
                " WHERE u.class_code = ? GROUP BY r.scenario", (code,)).fetchall()
        for row in rows:
            best.setdefault(row["scenario"], {
                "grade": row["grade"], "score": row["score"], "profit": row["profit"], "nickname": row["nickname"],
                "on_time": row["on_time"], "ships": row["ships"], "at": row["created_at"]})
        for row in players:
            if row["scenario"] in best:
                best[row["scenario"]]["players"] = row["n"]
        return {"class_code": code, "best": best}
