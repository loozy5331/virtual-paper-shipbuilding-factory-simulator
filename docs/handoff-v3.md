# 컨셉 v3 인수인계: main(629fa8e) 이후 변경 사항

클라우드 세션(2026-10-07)에서 논의하고 엔진 복사본으로 시험한 내용이다. **저장소 코드(sim.py, scenario.json, presets.json, 테스트, ui)는 아직 바뀌지 않았다.**
숫자는 모두 프로토타입(부록 B)으로 계산한 시험값이며, 실제 엔진에 넣은 뒤 테스트로 다시 고정해야 한다.

> 참고: 이 세션 브랜치 `claude/factory-tycoon-production-manager-pnsyzz`에는 push되지 않은 로컬 커밋 1개(`docs/concept-v2.md`, CLAUDE.md 메모)가 있었다.
> 그 문서는 초기 안(첫 고장 현장 출동, 이익 목표 3,000 등)이라 **이 문서로 대체**한다.

---

## 1. 콘셉트 한 줄

스마트야드 관제실의 생산관리자가 분기 계획(KPI)을 세우고 60일을 돌린 뒤, 등급을 보고, 현장 재현으로 원인을 찾아, 설정을 바꿔 재시도한다(PDCA).

| 항목 | 결정 |
|---|---|
| 실행 중 개입 | 없음. 설정은 기간 내내 유지 (엔진 결정성 유지) |
| 기간 | 분기, MVP 60일. 스테이지(365일, n년)는 나중 |
| KPI | 인도 매출, 이익. 납기 준수율과 직행률은 점수에 포함 |
| KPI 대상 | 수주일과 인도 예정일이 모두 분기 안에 있는 배 (MVP는 4척 모두 해당) |
| 현장 | "재현": 같은 결과를 3D로 다시 재생하며 원인 확인. 엔진 재실행 없음 |
| 비교 | 실행 간 비교 레포트(`compare.ts`, 비교 탭) **삭제**. 기준선 대비 등급으로 대체 |

## 2. 시연 흐름 (CLAUDE.md의 7단계를 대체)

1. 분기 목표와 수주 4척 표시
2. 계획 수립: [공통 | S1 | S2 | S3 | S4] 탭
3. 자원 배치: 공통 탭(공법, 잔업, 정비, 시니어, 트랜스포터)
4. 60일 진행: 관제실 [대시보드 3D | 간트], 현장 탭 잠금
5. 레포트: 등급, 항목별 점수, 기준선 대비 한 줄, 의문점 카드
6. 현장 재현: 안전모 쓰고 뛰어나가는 전환 → 원인 확인
7. 재시도: 같은 수주·난수로 설정만 바꿔 다시 실행, "이번 세션 최고 등급" 갱신

## 3. 규칙 변경 (scenario.json, sim.py)

### 3.1 공정: 블록 조립 (로트 방식)

| 공정 | 블록 | 자재 | 설비 | 기존 자리 |
|---|---|---|---|---|
| 소조립 | 12 | 종이 | 소조립 정반 | 재단 |
| 중조립 | 12→6 | 없음 | 중조립 정반 | 풀칠 |
| 대조립 | 6→3 | 물감 | 대조립 정반 | 물감칠 |
| 탑재 | 3→1척 | 깃발 | 골리앗 크레인 | 의장 |

- 작업량, BOM, 단가, 난수표 값은 기존 공정 자리를 그대로 쓴다. id 제안: `sub_assembly`, `block_assembly`, `grand_assembly`, `erection`.
- 엔진은 **배 한 척의 공정 로트** 단위로 계산한다. 블록 합침(12→6→3→1)은 진행률에 맞춰 3D가 그린다.
- 블록 단위 시뮬레이션(짝 블록 대기)은 스테이지 버전 확장 과제.

### 3.2 수주: S4 추가

```json
{"id": "S4", "type": "CONT", "due_day": 56, "price": 2600}
```
- 품질 난수(S4, 공정 순): 0.55, 0.13, 0.69, 0.26
- `orders`에 `order_day`(MVP는 모두 1)를 추가해 KPI 대상 필터에 쓴다.

### 3.3 작업대기소 (인력 풀)

- 설정: 작업장별 `workers` 대신 `pool`(총인원).
- 배치 규칙(고정): **배 우선순위 순**. 배가 있고 중지 상태가 아닌 작업장이 2명 요청(자동화 셀 완료 후 1명).
- 처리량 = min(배정 인원 × (자동화면 2, 아니면 1), 2) × 공법 속도 × 잔업 계수. 최대 3.75는 그대로.
- 하루 순서: 입고 → **운반** → 전 작업장 투입 → **인원 배정** → 작업·잔업·사고·고장 판정·검사 → 기록 → 비용.
- 인건비 = pool × 10 × 60 (+ 시니어 수당). 잔업수당 = 그날 배정 인원 × 10 × 0.5.
- 시니어: 지정 공정 고정, 불량률 −0.05, pool에 포함 안 함.
- 새 손실 상태: `labor_wait`(인력 대기). 새 지표: 작업자 가동률 = 배정 인일 ÷ (pool × 60).

### 3.4 트랜스포터 (공정 사이 운반)

- 설정: `transporters: {count: 1~2, maintenance: bool}`. 대당 5/일, 정비 50/대. 운전원은 pool에 포함 안 함.
- 로트 무게 12 (블록 수는 줄어도 무게는 같다: 소 1×12, 중 2×6, 대 4×3). 1대가 하루 6을 나른다.
- 공정을 끝낸 다음 날부터 운반. 다 나른 날 바로 다음 공정 투입 가능. → 1대면 운반 2일, 2대면 1일.
- 하루 운반 순서는 배 우선순위 순. 못 나른 로트는 `transport_wait`, 나르는 중이면 `transport`(손실 아님).
- 탑재 후에는 운반 없음(완료일 = 인도일).
- 고장: 운행 6회마다 판정, 기준 미정비 0.4 / 정비 0.1, 중지 2일, 수리비 150, 난수표 `[0.25, 0.6, 0.15]`.

### 3.5 설비 고장 (작업장, 골리앗 크레인 포함)

- 작업장이 일한 날 8일마다 판정. 기준 미정비 0.4 / 정비 0.1. 중지 2일, 수리비 150.
- 난수표(공정 순): `[0.33,0.58,0.12]`, `[0.05,0.47,0.81]`, `[0.66,0.22,0.39]`, `[0.52,0.08,0.74]`
- 사고(기존 잔업 규칙)와 고장은 엔진에서 따로 기록한다. 화면에서는 "중지" 한 색 + 원인 라벨.

### 3.6 연구소

- 계획 단계에서 대기열 순서를 정한다. 1일부터 한 번에 하나씩, 완료 다음 날부터 효과. 비용은 대기열에 넣으면 전액.

| id | 이름 | 비용 | 기간 | 효과 | 열어 주는 운영 |
|---|---|---|---|---|---|
| `automation` | 자동화 셀 | 500 | 12일 | 1명이 설비를 2명처럼, 작업장이 1명만 요청 | 인원 축소 |
| `auto_inspect` | 자동 검사 | 300 | 8일 | 불량률 −0.20, 재작업량 50%→25% | 속성 공법 |
| `predictive` | 예지 정비 | 250 | 8일 | 모든 설비 고장 없음, 미정비 불량 가산 없음 | 정비 생략 |

### 3.7 등급

- 경영 목표: 인도 매출 11,200, 이익 **4,200**, 납기 준수율 100%, 직행률 90%.
- 점수 = 30×min(매출/11,200, 1) + 40×min(max(이익/4,200, 0), 1.3) + 20×납기 준수율 + 10×min(직행률/0.9, 1). 최고 112.
- 등급: **S ≥105, A ≥85, B ≥70, C ≥50, F <50**.
- 기준선 = 전부 최대 투입 프리셋(C). 기준선 결과는 엔진이 함께 계산해 돌려준다.
- 레포트 맨 위: 등급, 항목별 점수, 기준선 대비 한 줄(예: "전부 최대 투입 대비 이익 +6,188, 인원 −6명").

### 3.8 자재창고 (규칙 변경 없음)

- 기존 공용 재고, 입고, 재고비 그대로. 용량 제한 없음.
- 엔진 추가: 투입할 때 출고 이벤트 `{type: "issue", material, quantity, ship, station}`.

### 3.9 결과에 추가할 것

- `events`: `breakdown`(station 또는 transporter), `issue`, `transport_start/end`, `research_done`
- 배 상태: `labor_wait`, `transport_wait`, `transport`, `breakdown_stop`(사고 `accident_stop`과 구분)
- 설비별 일자 기록(트랜스포터, 연구소) — 간트 줄용
- `grade`: 점수, 항목별 점수, 등급, 기준선 결과 요약
- `findings`: 의문점 카드용 손실 구간 목록(종류, 공정/설비, 시작·끝 날짜, 크기)
- `end_state`: 완료한 연구, 재고, 진행 중 배 (스테이지 확장 대비)

## 4. 프리셋 (presets.json)

| 프리셋 | pool | 트랜스포터 | 나머지 |
|---|---|---|---|
| 무관리 | 8 | 1대, 미정비 | 기존 + S4 `{priority 4, start 1, order 1/10/20}` |
| 관리 | 6 | 1대, 정비 | 기존 + S4 `{priority 4, start 23, order 20/33/36}` |
| 전부 최대 투입 (기준선) | 8 | 1대, 정비 | 기존 + S4 `{priority 4, start 1, order 1/1/1}` |

연구 대기열은 세 프리셋 모두 비어 있다.

## 5. 시험 결과 (프로토타입, 테스트 기대값 후보)

| 설정 | T | 인원 | 이익 | 납기 | 점수 | 등급 |
|---|---|---|---|---|---|---|
| 무관리 | 1 | 8 | −2,978.2 | 2/4 | 43.5 | F |
| 전부 최대 투입 | 1 | 8 | −1,410.4 | 4/4 | 55.6 | C |
| 관리 | 1 | 6 | 2,938.0 | 4/4 | 88.0 | A |
| 관리 | 2 | 6 | 2,596.0 | 4/4 | 84.7 | B |
| 관리 | 1 | 4 | 4,086.4 | 4/4 | 98.9 | A |
| 관리 | 1 | 3 | 1,156.4 | 2/4 | 54.0 | C |
| 관리 + 자동화 셀 | 1 | 2 | 4,777.6 | 4/4 | 105.5 | S |
| 관리 + 자동화 셀 | 2 | 2 | 4,503.2 | 4/4 | 102.9 | A |
| 관리, 속성 + 자동 검사 → 자동화 | 1 | 2 | 4,755.2 | 4/4 | 105.3 | S |
| 관리, 정비 생략 + 예지 정비 → 자동화 (트랜스포터 미정비) | 1 | 2 | 4,909.6 | 2/4 | 96.8 | A |
| 관리, 정비 생략 + 예지 정비 → 자동화 (트랜스포터 미정비) | 2 | 2 | 5,047.8 | 4/4 | 108.1 | S |

읽는 법: 인력 풀만으로 원가가 크게 준다(가동률 30~40% → 대기의 낭비). 4명→3명에서 무너진다. 연구는 운영과 함께 바꿔야 돈이 된다. 트랜스포터는 보통 1대가 맞고, 정비 생략 경로에서만 2대가 필요하다.

## 6. 화면

### 6.1 구조
```
[관제실]  [현장 🔒]  [레포트]
   └ [대시보드 3D] [간트]      ← 재생 커서 공유
```
- 계획 화면: 4척 요약 줄(우선순위 맞바꿈, 착수일, 납기) + [공통 | S1 | S2 | S3 | S4] 탭
  - 공통: pool, 연구 대기열, 공정별 공법·잔업·정비, 시니어 공정, 트랜스포터 대수·정비
  - 배 탭: 착수일, 발주일 3개, "이 배만 역산"(요약 줄에 "전체 역산"), 배 정보
  - 탭 라벨에 문제 표시(예: "S2 ⚠"). 탭 전환은 숨김/표시만 해서 입력란을 다시 만들지 않는다(커서 유지).
  - 발주일 옆에 "재고는 4척이 함께 씁니다" 안내.
- 간트: 배 4줄 + 연구소 줄 + 트랜스포터 줄(대별) + 골리앗 크레인 줄. 손실 구간은 빗금 + 라벨.
- 레포트: 등급, 항목별 점수, 기준선 대비 한 줄, 의문점 카드 2~3개, QCD, 원가, 리드타임 분해, OEE, 작업자 가동률, 재고 금액 추이.
- `compare.ts`와 비교 탭 삭제. 이번 세션 최고 등급은 화면 상태로만 보관.

### 6.2 3D
- 현장 구성: 소·중·대조립 정반, 탑재 도크와 골리앗 크레인, 트랜스포터, 작업대기소, 자재창고(종이·물감·깃발 선반), 연구소.
- 현장 전환: 관리자가 안전모를 쓰고 관제실 문으로 뛰어나감 → 현장 탭. 건너뛰기 가능. 재현 진입 시 1회.
- 이동시간 0. 걷기·운반 애니메이션은 1배속 이하에서만, 빠르면 즉시 이동.
- 원인별 모습:

| 상태 | 모습 |
|---|---|
| 인원 과다 | 대기소에 사람이 앉아 있음 |
| 인력 대기 | 로트는 있는데 정반이 비어 있음 |
| 자재 대기 | 창고 선반이 비고 "입고 D-n" 팻말 |
| 재고 과다 | 창고 바닥까지 상자 |
| 작업장 대기 | 로트가 정반 앞에 줄 섬 |
| 운반 대기 | 트랜스포터 앞에 로트가 줄 섬 |
| 고장 / 사고 | 연기 / 통제 테이프 |
| 재작업 | 빨간 태그 |

- 3D 우선순위(주말 범위): 블록 합침과 골리앗 > 대기소·선반 > 트랜스포터 > 입고 트럭·운반차.

### 6.3 색 (색각 검증기 통과값, 배경 #EAF0EB, 전체 쌍)

| 용도 | 값 |
|---|---|
| 공정 4색 | 기존 그대로: #2a78d6, #e87ba4, #008300, #4a3aa7 |
| 손실: 중지(사고·고장) | #8e2e42 |
| 손실: 재작업 | #cf3d0b |
| 손실: 자재 대기 | #de9644 |
| 손실: 인력 대기 | #56b6d5 |
| 손실: 대기(작업장·운반) | #898781 (중립 회색, 라벨로 구분) |
| 작업모: 작업자 / 관리자 / 시니어 | #d6a400 / #d9480f / #6f42c1 |

- 기존 손실 4색(#ec835a, #fab219, #898781, #d03b3b)은 검증 실패라 교체한다. `ui/src/labels.ts`, CLAUDE.md 색 메모를 함께 고친다.
- 손실 5색: CVD 최소 11.9, 정상시 최소 15.1. 자재 대기·인력 대기는 대비 3:1 미만이라 라벨 필수.
- 작업모 3색끼리는 통과(CVD 14.1)지만 손실색·공정색과 겹친다 → 손실 소품은 아이콘·라벨, 바닥 구역색은 옅게, 작업모에 어두운 외곽선, 관리자 조끼·태블릿, 시니어 흰 띠.

## 7. 작업 순서 제안

1. 규칙 문서(Claude Docs) 갱신: 3장 전체, 5장 숫자.
2. 엔진: 공정 id·이름 교체 → S4 → pool·배정 → 운반 → 고장 → 연구 → 등급·기준선 → 이벤트·findings·end_state.
   단계마다 `python -m unittest`로 확인하고, 마지막에 5장 표를 기대값으로 고정.
3. 서버: `/api/simulate` 응답에 grade, baseline, findings 추가. `/api/preview`에 트랜스포터 비용.
4. 화면: 계획 탭 → 간트 줄 추가 → 레포트 등급 → 비교 삭제 → 3D 관제실/현장.
5. CLAUDE.md 갱신: 시연 흐름, 규칙 요약, 프리셋 숫자, 색.

## 부록 A. scenario.json 추가분 (프로토타입 기준)

```json
{
  "research": {
    "automation":   {"name": "자동화 셀", "cost": 500, "days": 12},
    "auto_inspect": {"name": "자동 검사", "cost": 300, "days": 8, "defect_sub": 0.20, "rework_ratio": 0.25},
    "predictive":   {"name": "예지 정비", "cost": 250, "days": 8}
  },
  "breakdown": {
    "every_busy_days": 8, "threshold": 0.4, "threshold_maintained": 0.1, "stop_days": 2, "cost": 150,
    "table": {
      "sub_assembly":   [0.33, 0.58, 0.12],
      "block_assembly": [0.05, 0.47, 0.81],
      "grand_assembly": [0.66, 0.22, 0.39],
      "erection":       [0.52, 0.08, 0.74]
    }
  },
  "transporter": {
    "capacity": 6, "lot_weight": 12, "cost_per_day": 5, "maintenance_cost": 50,
    "every_moves": 6, "threshold": 0.4, "threshold_maintained": 0.1, "stop_days": 2, "repair_cost": 150,
    "table": [0.25, 0.6, 0.15]
  },
  "blocks": {"sub_assembly": 12, "block_assembly": 6, "grand_assembly": 3, "erection": 1},
  "kpi": {"revenue": 11200, "profit": 4200, "on_time_rate": 1.0, "first_pass_yield": 0.9},
  "grade": {"weights": {"revenue": 30, "profit": 40, "delivery": 20, "quality": 10},
            "profit_cap": 1.3, "bands": {"S": 105, "A": 85, "B": 70, "C": 50}}
}
```

## 부록 B. 프로토타입 엔진 (proto/sim5.py)

시험용 압축 코드다. 공정 id는 옛 이름(cutting…)을 그대로 쓴다. 실제 구현은 sim.py 구조(검사, 기록, segments, OEE)를 유지하면서 이 로직을 옮긴다.

```python
"""프로토타입: 인력 풀(작업대기소) + S4 + 설비 고장(고정 2일) + 연구 + 트랜스포터. 배치 규칙: 배 우선순위 순."""
import math
EPS=1e-9
def simulate(cfg, sc):
    days=sc["days"]; rules=sc["rules"]; costs=rules["costs"]; ot=rules["overtime"]
    orders=sc["orders"]; stations=sc["stations"]; mats={m["id"]:m for m in sc["materials"]}; types=sc["ship_types"]
    n, ns = len(orders), len(stations)
    R=sc["research"]; BD=sc["breakdown"]
    stc=[cfg["stations"][s["id"]] for s in stations]; skilled=cfg.get("skilled_station")
    pool=cfg["pool"]
    # 연구 완료일
    done={}; t=1
    for rid in cfg.get("research",[]):
        done[rid]=t+R[rid]["days"]-1; t=done[rid]+1
    work=lambda i,p: types[orders[i]["type"]]["work"][stations[p]["id"]]
    bom=lambda i,m: types[orders[i]["type"]]["bom"].get(m,0)
    prio={i:cfg["ships"][o["id"]]["priority"] for i,o in enumerate(orders)}
    arrivals={}
    for i,o in enumerate(orders):
        for m,d in cfg["ships"][o["id"]]["order_days"].items():
            if bom(i,m): arrivals.setdefault(d+mats[m]["lead_days"],[]).append((m,bom(i,m)))
    stock={m:0 for m in mats}
    stage=[0]*n; ready=[cfg["ships"][o["id"]]["start_day"] for o in orders]
    started=[None]*n; delivered=[None]*n; cur=[None]*ns; stop_until=[0]*ns; otdays=[0]*ns; busy=[0]*ns
    cost=dict(labor=0,overtime=0,maintenance=0,material=0,holding=0,wip=0,rework=0,accident=0,breakdown=0,late_penalty=0,research=0)
    insp=passes=0; defects=acc=0; bds=[]; man_days=0; labor_wait_days=0
    TR=sc["transporter"]; tcfg=cfg["transporters"]; ntr=tcfg["count"]
    tr_moves=[0]*ntr; tr_stop=[0]*ntr; pending={}; pending_w={}; transport_wait_days=0; tr_bds=[]
    for day in range(1,days+1):
        active={r for r,d in done.items() if d<day}
        for m,q in arrivals.get(day,[]): stock[m]+=q
        sstate={}
        # 0. 운반: 트랜스포터 1대는 하루 capacity만큼 나른다. 로트 무게를 다 나른 날 다음 공정에 투입할 수 있다.
        free_tr=[k for k in range(ntr) if day>tr_stop[k]]
        capa=TR["capacity"]*len(free_tr)
        for i in sorted([i for i,d in pending.items() if d<day], key=prio.get):
            if capa>0:
                take=min(capa,pending_w[i]); pending_w[i]-=take; capa-=take
                if pending_w[i]<=0:
                    ready[i]=day; del pending[i]
                else: sstate[i]="transport"
            else:
                sstate[i]="transport_wait"; transport_wait_days+=1
        trips=math.ceil((TR["capacity"]*len(free_tr)-capa)/TR["capacity"]) if free_tr else 0
        for k in free_tr[:trips]:
            tr_moves[k]+=1
            if tr_moves[k]%TR["every_moves"]==0:
                th=0 if "predictive" in active else (TR["threshold_maintained"] if tcfg["maintenance"] else TR["threshold"])
                tb=TR["table"]
                if tb[(tr_moves[k]//TR["every_moves"]-1)%len(tb)]<th:
                    tr_stop[k]=day+TR["stop_days"]; cost["breakdown"]+=TR["repair_cost"]; tr_bds.append((day,k))
        # A. 투입
        for p in range(ns):
            waiting=[i for i in sorted(range(n),key=prio.get) if delivered[i] is None and stage[i]==p and ready[i]<=day and not (cur[p] and cur[p]["ship"]==i)]
            if day<=stop_until[p]:
                for i in waiting+([cur[p]["ship"]] if cur[p] else []): sstate[i]="stop"
                continue
            if cur[p] is None:
                m=stations[p]["material"]
                for i in waiting:
                    if m and stock[m]<bom(i,m): sstate[i]="material_wait"; continue
                    if m: stock[m]-=bom(i,m)
                    cur[p]={"ship":i,"rem":work(i,p),"rework":False}
                    if p==0: started[i]=day
                    break
            for i in waiting:
                if i not in sstate and not (cur[p] and cur[p]["ship"]==i): sstate[i]="station_wait"
        # B. 인원 배정: 배 우선순위 순
        need=1 if "automation" in active else 2
        free=pool; assigned=[0]*ns
        for p in sorted([p for p in range(ns) if cur[p] and day>stop_until[p]], key=lambda p: prio[cur[p]["ship"]]):
            a=min(need,free); assigned[p]=a; free-=a
        man_days+=pool-free
        # C. 작업
        for p in range(ns):
            if not cur[p] or day<=stop_until[p]: continue
            i=cur[p]["ship"]
            if assigned[p]==0: sstate[i]="labor_wait"; labor_wait_days+=1; continue
            eff=min(assigned[p]*(2 if "automation" in active else 1),2)
            c=stc[p]; rate=eff*rules["methods"][c["method"]]["speed"]*(ot["speed"] if c["overtime"] else 1)
            cur[p]["rem"]-=rate; busy[p]+=1
            sstate[i]="rework" if cur[p]["rework"] else "work"
            pid=stations[p]["id"]
            if c["overtime"]:
                otdays[p]+=1; cost["overtime"]+=assigned[p]*costs["wage_per_day"]*ot["pay_rate"]
                if otdays[p]%ot["accident_every_days"]==0:
                    tb=sc["random"]["accident"][pid]
                    if tb[(otdays[p]//ot["accident_every_days"]-1)%len(tb)]<ot["accident_threshold"]:
                        stop_until[p]=day+ot["accident_stop_days"]; cost["accident"]+=costs["accident"]; acc+=1
            if busy[p]%BD["every_busy_days"]==0 and day>stop_until[p]:
                tb=BD["table"][pid]; th=BD["threshold_maintained"] if c["maintenance"] else BD["threshold"]
                if "predictive" in active: th=0
                if tb[(busy[p]//BD["every_busy_days"]-1)%len(tb)]<th:
                    stop_until[p]=day+BD["stop_days"]; cost["breakdown"]+=BD["cost"]; bds.append((day,pid))
            if cur[p]["rem"]<=EPS:
                if not cur[p]["rework"]:
                    insp+=1
                    d=rules["methods"][c["method"]]["defect_rate"]+(ot["defect_add"] if c["overtime"] else 0)+(0 if c["maintenance"] or "predictive" in active else rules["no_maintenance_defect_add"])-(rules["skilled_defect_reduction"] if skilled==pid else 0)
                    if "auto_inspect" in active: d-=R["auto_inspect"]["defect_sub"]
                    if sc["random"]["quality"][orders[i]["id"]][pid]<round(max(0,d),6):
                        cur[p]["rem"]=work(i,p)*(R["auto_inspect"]["rework_ratio"] if "auto_inspect" in active else rules["rework_ratio"]); cur[p]["rework"]=True; cost["rework"]+=costs["rework_per_defect"]; defects+=1; continue
                    passes+=1
                stage[i]+=1; cur[p]=None
                if p<ns-1: ready[i]=10**9; pending[i]=day; pending_w[i]=TR["lot_weight"]
                if p==ns-1: delivered[i]=day
        cost["holding"]+=sum(stock[m]*mats[m]["price"] for m in stock)*costs["holding_rate_per_day"]
        cost["wip"]+=sum(costs["wip_per_ship_day"] for i in range(n) if started[i] is not None and delivered[i] is None)
    cost["labor"]=(pool*costs["wage_per_day"]+(costs["skilled_bonus_per_day"] if skilled else 0))*days
    cost["maintenance"]=sum(1 for c in stc if c["maintenance"])*costs["maintenance_per_station"]
    cost["material"]=sum(bom(i,m)*mats[m]["price"] for i in range(n) for m in mats)
    cost["transporter"]=ntr*TR["cost_per_day"]*days+(ntr*TR["maintenance_cost"] if tcfg["maintenance"] else 0)
    cost["research"]=sum(R[r]["cost"] for r in cfg.get("research",[]))
    late=[max(0,(delivered[i] or days)-o["due_day"]) for i,o in enumerate(orders)]
    cost["late_penalty"]=sum(l*o["price"]*costs["late_penalty_rate_per_day"] for l,o in zip(late,orders))
    total=sum(cost.values()); rev=sum(o["price"] for i,o in enumerate(orders) if delivered[i])
    ontime=sum(1 for i in range(n) if delivered[i] and late[i]==0)
    return dict(revenue=rev,profit=round(rev-total,1),ontime=ontime,n=n,late=sum(late),fpy=passes/insp if insp else 0,
                delivered=delivered,bds=bds,util=man_days/(pool*days),labor_wait=labor_wait_days,
                transport_wait=transport_wait_days,tr_bds=tr_bds,cost={k:round(v,1) for k,v in cost.items()},defects=defects,acc=acc)
```

점수 계산(시험 스크립트):
```python
score = 30*min(rev/11200, 1) + 40*max(0, min(profit/4200, 1.3)) + 20*ontime/n + 10*min(fpy/0.9, 1)
grade = 'S' if score>=105 else 'A' if score>=85 else 'B' if score>=70 else 'C' if score>=50 else 'F'
```
