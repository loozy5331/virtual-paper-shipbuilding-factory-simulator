"""종이배 조선소 로컬 서버.

엔진(engine/shipyard)을 HTTP로 감싸고, 빌드된 화면(ui/dist)을 함께 내보낸다.
표준 라이브러리만 쓰므로 설치할 것이 없다.

    python server/app.py            # http://localhost:8000
    python server/app.py --port 9000 --no-open

API
    GET  /api/scenario          버전, 수주, BOM, 규칙, 프리셋
    POST /api/simulate          {"config": {...}}  ->  시뮬레이션 결과, 등급과 기준선 비교
    POST /api/preview           {"config": {...}}  ->  공정별 최대 처리량, 불량률, 고정비, 연구 일정
    POST /api/suggest-orders    {"config": {...}}  ->  역산한 발주일
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from shipyard import (  # noqa: E402
    __version__,
    ConfigError,
    load_presets,
    load_scenario,
    max_rate,
    preview,
    simulate,
    suggest_order_days,
)

UI_DIR = ROOT / "ui" / "dist"
MAX_BODY = 1_000_000


def scenario_payload() -> dict:
    scenario = load_scenario()
    return {"version": __version__, "scenario": scenario, "presets": load_presets(), "max_rate": max_rate(scenario["rules"])}


POST_ROUTES = {
    "/api/simulate": lambda config: simulate(config),
    "/api/preview": lambda config: preview(config),
    "/api/suggest-orders": lambda config: {"order_days": suggest_order_days(config)},
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"PaperShipyard/{__version__}"

    # ----- 응답 도우미 -----
    def send_json(self, payload, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: HTTPStatus, messages: list[str]) -> None:
        self.send_json({"errors": messages}, status)

    # ----- GET: API 한 개와 정적 파일 -----
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/scenario":
            self.send_json(scenario_payload())
            return
        if path.startswith("/api/"):
            self.send_error_json(HTTPStatus.NOT_FOUND, [f"없는 주소입니다: {path}"])
            return
        self.send_static(path)

    def send_static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (UI_DIR / relative).resolve()
        if UI_DIR.resolve() not in target.parents or not target.is_file():
            if not (UI_DIR / "index.html").is_file():
                self.send_error_json(HTTPStatus.NOT_FOUND,
                                     ["화면이 아직 빌드되지 않았습니다. ui 폴더에서 npm install, npm run build를 실행하세요."])
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, [f"없는 파일입니다: {path}"])
            return
        body = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ----- POST: 엔진 호출 -----
    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        route = POST_ROUTES.get(path)
        if route is None:
            self.send_error_json(HTTPStatus.NOT_FOUND, [f"없는 주소입니다: {path}"])
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self.send_error_json(HTTPStatus.BAD_REQUEST, ["요청 본문이 없거나 너무 큽니다"])
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            config = payload["config"]
            if not isinstance(config, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            self.send_error_json(HTTPStatus.BAD_REQUEST, ['본문은 {"config": {...}} 형태의 JSON이어야 합니다'])
            return
        try:
            self.send_json(route(config))
        except ConfigError as error:
            self.send_error_json(HTTPStatus.UNPROCESSABLE_ENTITY, error.messages)

    def log_message(self, fmt: str, *args) -> None:
        if self.path.startswith("/api/"):
            sys.stderr.write(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="종이배 조선소 시뮬레이터 서버")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="브라우저를 자동으로 열지 않는다")
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("image/svg+xml", ".svg")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    print(f"종이배 조선소: {url}  (끝내려면 Ctrl+C)")
    if not args.no_open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 끝냅니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
