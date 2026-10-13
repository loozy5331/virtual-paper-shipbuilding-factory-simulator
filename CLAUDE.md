# 종이배 조선소 시뮬레이터: 작업 인수인계

사용자와는 한국어로 대화한다. 사용자는 주니어 개발자다. 시니어가 조언하듯 이유를 붙여 설명한다.

## 프로젝트

- 목적: 조선업 생산관리 교육(7요소, QCD, 4M) 복습과 시연. 게임 완성도보다 "배운 개념이 화면에서 보이는가"가 기준이다.
- 규칙의 기준 문서(Claude Docs): https://claude.ai/code/artifact/63f9424c-6a92-461b-8fb0-06a2820778d0
  docs 도구로 읽고 고친다. 통째로 읽지 말고 `search`나 `view` + `parentId`로 고칠 곳만 읽는다.
- 버전: 4.21.0(2026-10-13, 새 시나리오 고부가가치 수주 `premium`, 선가 비례 위약금). 4.20.0: 선종 다변화 `mix`(혼류 생산). 4.19.0: 선종 난이도와 신규 선종 4종, 선종별 3D 선체 모양. 4.18.0: 관제실 오른쪽 모니터 [작업 현황 / 선박별] 탭. 4.17.2: 책상 달력을 맨 왼쪽, 생산계획서를 가운데 쪽으로. 4.17.1: 관제실 책상 달력으로 반기 바꾸기, 명판 반기 메뉴 없앰. 4.17.0: 생산계획서 선박 사양서, 선종 데이터 `look`·`spec`. 4.16.2: 기준선 캐시로 채점 속도. 4.16.1: 현장 3인칭 W·A·S·D. 4.16.0: 관제실 간트의 계획 줄. 4.15.6~4.15.9: UI·그래픽 개선(간트 실제 픽셀, 작업 현황 지도 글자와 아래 줄, 첫 화면 카드, 언덕). 4.15.0: 7관리 지표와 공정 여유. 지난 버전은 `CHANGELOG.md`, 결정 기록은 `docs/handoff-v2.0.md`(D10~D68).
- 다음: 시나리오 사다리 6개 완료(D67·D68). 4.x 이후 목록(인도 기준 엔진 규칙, 특수선·해양 야드 등). `docs/roadmap.md`
- 브랜치: `main`은 MAJOR만, 작업은 `develop`에서 따서 `develop`으로 PR(규칙은 `CHANGELOG.md`). 버전은 엔진 `__init__.py`, `ui/package.json`·`package-lock.json`이 같은 값.
- 세부 메모(시연 흐름, 규칙 요약, 화면·3D 세부, 예시 계획 점수): `docs/notes.md`. 필요한 절만 grep으로 찾아 읽는다.

## 구조

- `engine/shipyard/sim.py`: 엔진. `simulate(config, scenario=None, baseline=True) -> dict`. 표준 라이브러리만, 화면·서버를 모른다. 결과의 `grade`를 위해 기준선 프리셋도 함께 돌린다. 기준선은 시나리오·프리셋 내용 해시로 캐시한다(4.16.2, `_baseline_summary`). 기준선을 결과가 아닌 다른 것(코드 밖 전역 상태 등)에 기대게 바꾸면 키에 넣는다.
- `engine/shipyard/data/rules.json`(공통 규칙 숫자) + `data/scenarios/<id>.json`(수주·기간·목표·등급·난수·프리셋 3개·`options`). `load_scenario(id)`가 합친다. 시나리오: simple(입문, 간이공정)·basic·growth(수주 증가)·mix(선종 다변화, 4.20)·surge(수주 급증)·premium(고부가가치 수주, 4.21).
- 분기별 옵션(D33): 시나리오 `options`에 없는 옵션은 생산계획서(`form.ts` `openOptions`)가 그리지 않고 엔진(`_locked_options`)이 거절한다. 테스트는 `opened()`로 잠금을 푼다.
- `engine/tests/test_rules_doc.py`: 규칙 문서 10장 값과 버전별 규칙 검증(120개). `engine/tools/balance.py`: 지배 전략 점검.
- `server/app.py`: 표준 라이브러리 HTTP 서버(API + `ui/dist`). `server/store.py`: sqlite3(users·auth·runs), 파일 `server/data/shipyard.sqlite3`(git 제외).
- `ui/`: 프레임워크 없는 TypeScript + esbuild. `main.ts`(상태·화면 전환), `form.ts`(생산계획서), `cctv.ts`(관제실 2D 작업 현황), `shipboard.ts`(관제실 선박별 진행), `gantt.ts`, `report.ts`, `spec.ts`(선박 사양서), `profile.ts`(배 옆모습), `api.ts`(타입), `labels.ts`(이름·색). 3D는 `ui/src/scene/`: `frame.ts`(결과 → 그날 장면, 순수 함수), `layout.ts`(모든 자리 좌표와 선종 그림 `lookOf`, 2D·3D 공용), `yard.ts`(Three.js 장면·카메라·매 프레임 그리기), `harbor.ts`(진수·예인선·계류줄), `lot.ts`(로트·배 모형), `props.ts`(줄·예인선·납품 배와 마차·호이스트·로봇 모형), `util.ts`(종이 재질·이름표·칩), `coast.ts`, `people.ts`, `ships.ts`, `stock.ts`.

## 지킬 것

1. 화면은 계산하지 않는다. 미리보기도 `/api/preview`에서 받는다.
2. 엔진은 결정적이다. 난수는 rules.json·시나리오 파일의 표에서 읽는다.
3. 규칙이나 숫자를 바꾸면 rules.json·시나리오 파일, 테스트 기대값, 규칙 문서를 함께 고친다. 코드보다 규칙 문서를 먼저. 테스트가 깨진 채로 두지 않는다.
4. 등급 구간·목표·예시 계획은 태그를 붙이는 배포마다 조율한다(D40). 새 선택지는 `balance.py`에 넣어 지배 전략이 아닌지 본다.
5. SimPy는 쓰지 않는다(하루 단위 틱 루프가 문서와 1:1).
6. 그림만 바꾸는 일(엔진 규칙 없음)은 결과 숫자를 바꾸지 않는다(PATCH/MINOR 구분은 `CHANGELOG.md`). 그림만 바뀐 작은 수정은 한 PR로 묶는다.

## 화면 원칙 (사용자 결정)

- 장식은 절제한다. 플래시 게임 같은 장식(나뭇결, 큰 금속 집게)은 뺐다. 종이 서식 = 생산계획서·생산실적 평가서, 결재란 작성 "Bell"·승인 "Loozy"(`paper.ts`).
- 화면에 "CCTV"라는 말을 쓰지 않는다. 지연 표시는 오늘 기준, 설비 합계는 기간이 끝난 뒤에만(결과를 미리 알려 주지 않게).
- 색은 색각 이상 검증을 통과한 값이다(`labels.ts`). 공정 10색. 관제실 전체 간트 막대에는 공정 이름을 쓰지 않고 아래 범례로 읽는다(4.12.9 사용자, 이름은 마우스를 올리면).
- 양식은 입력 중에 다시 그리지 않는다(커서가 빠진다). 날아가는 복제·펼친 계획서는 라디오 name을 뗀다. 클래스 `.ghost`는 쓰지 않는다(`.btn.ghost`와 겹침).
- 3D: CSS2D 라벨은 로트를 지울 때 요소를 직접 뗀다. `shadow.radius`는 건드리지 않는다(그림자가 사라짐). Three.js는 현장에서만 동적 import.
- 재생: 관제실 기본 4배속(하루 0.5초 ÷ 배속), 현장 1배속 하루 2초(`FIELD_MS_PER_DAY`).

## 확인과 명령

```bash
uv venv .venv                                              # 가상환경(Python 3.12, .python-version). 외부 패키지 없음
cd engine && ../.venv/bin/python -m unittest discover -s tests -t .   # 엔진 테스트
.venv/bin/python -m unittest discover -s server/tests -t server    # 저장소 테스트
cd engine && ../.venv/bin/python -m tools.balance growth -n 16        # 균형 점검(분기 하나 약 2분, 출력은 파일로)
cd ui && npx tsc --noEmit -p . && npm run build            # 타입 검사와 빌드
.venv/bin/python server/app.py --no-open                            # 서버 http://localhost:8000 (--host 0.0.0.0: 수업)
```

- Python은 시스템 3.9가 아니라 `.venv`(3.12)를 쓴다. 셸 상태가 이어지지 않으니 activate 대신 경로로 부른다. worktree에는 `.venv`가 없으므로(git 제외) 그 안에서 `uv venv .venv`로 만든다.
- 헤드리스 Chrome: scratchpad에 playwright-core를 설치하고 `/Applications/Google Chrome.app`을 headless로 쓴다(저장소에 넣지 않음). 스크린샷은 볼 부분만 잘라 찍는다. 시험 실행은 worktree 서버(다른 포트)로 해서 사용자 DB에 회차를 남기지 않는다.
- 병합 뒤에는 메인 체크아웃을 pull + 빌드하고, 엔진·서버가 바뀌었으면 8000번 서버를 재시작한다.
