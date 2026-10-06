# 종이배 조선소 시뮬레이터

생산관리 교육 내용(7요소, QCD, 4M)을 복습하려고 만드는 조선소 경영 시뮬레이터다.
플레이어가 4M을 정하면 종이배 3척을 60일 동안 만들고 QCD로 채점한다.
같은 수주로 두 번 실행해 설정 차이가 결과 차이를 어떻게 만드는지 비교한다.

규칙의 기준 문서: https://claude.ai/code/artifact/63f9424c-6a92-461b-8fb0-06a2820778d0

## 구성

| 폴더 | 내용 | 상태 |
| --- | --- | --- |
| `engine/shipyard` | 시뮬레이션 엔진. 순수 Python, 표준 라이브러리만 사용 | 완성, 테스트 통과 |
| `engine/tests` | 규칙 문서 10장의 검증값을 확인하는 테스트 14개 | 완성 |
| `server/app.py` | 엔진을 HTTP로 감싼 로컬 서버. 표준 라이브러리만 사용 | 완성 |
| `ui` | TypeScript 화면 | 빌드 설정만 있음, 화면 코드는 아직 없음 |

엔진과 화면의 경계는 하나다. 설정 JSON을 넣으면 결과 JSON이 나온다. 화면은 계산하지 않는다.

## 실행

Python 3.10 이상이면 설치할 것이 없다.

```bash
# 엔진 테스트
cd engine && python -m unittest discover -s tests -t .

# 서버 (http://localhost:8000). 화면이 빌드되기 전에는 API만 응답한다.
python server/app.py
```

엔진만 직접 써 볼 수도 있다.

```python
import sys; sys.path.insert(0, "engine")
from shipyard import simulate, load_presets

result = simulate(load_presets()[1]["config"])   # 관리 프리셋
print(result["qcd"], result["profit"])           # 이익 1746.2
```

## API

| 주소 | 요청 | 응답 |
| --- | --- | --- |
| `GET /api/scenario` | 없음 | 수주, BOM, 규칙 숫자, 프리셋 3개, 최대 처리량 |
| `POST /api/simulate` | `{"config": {...}}` | 60일 기록과 레포트 값 |
| `POST /api/preview` | `{"config": {...}}` | 작업장별 처리량과 불량률, 고정비 |
| `POST /api/suggest-orders` | `{"config": {...}}` | 필요일에서 역산한 발주일 |

설정이 규칙에 맞지 않으면 422와 `{"errors": [...]}`를 돌려준다.
설정의 모양은 `engine/shipyard/data/presets.json`을, 결과의 모양은 `engine/shipyard/sim.py`의 `simulate`를 보면 된다.

## 규칙을 바꿀 때

숫자(단가, 작업량, 납기, 난수표)는 `engine/shipyard/data/scenario.json`에만 있다.
숫자나 규칙을 바꾸면 10장의 기대값이 달라지므로 테스트와 규칙 문서를 함께 고친다.
