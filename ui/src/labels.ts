// 화면에 쓰는 이름과 색. 색은 색각 이상 검증기를 통과한 값이다(CLAUDE.md 참고).
// 색만으로 구분하지 않도록, 색을 쓰는 곳에는 항상 라벨이나 범례를 함께 둔다.

/** 고깔모자(작업모) 색: 역할. 3D 소인과 2D 작업 현황 기호가 함께 쓴다. */
export const HAT = { worker: "#d6a400", manager: "#d9480f", senior: "#6f42c1" } as const;

export const STATION_COLOR: Record<string, string> = {
  sub_assembly: "#2a78d6",
  block_assembly: "#e87ba4",
  grand_assembly: "#008300",
  erection: "#4a3aa7",
};

// 막대 안 글자색. 중조립 분홍은 밝아서 흰 글자가 안 읽히므로 어두운 글자를 쓴다.
export const STATION_TEXT: Record<string, string> = {
  sub_assembly: "#ffffff",
  block_assembly: "#1f2a24",
  grand_assembly: "#ffffff",
  erection: "#ffffff",
};

export interface StateInfo {
  state: string;
  name: string;
  color: string;
  /** 같은 색을 쓰는 상태끼리 구분하려고 빗금을 얹는다. */
  hatch?: boolean;
}

// 손실 5색(검증기 통과: CVD 최소 11.9, 정상시 최소 15.1).
// 자재 대기와 인력 대기는 배경 대비가 3:1 미만이라 라벨이 꼭 있어야 한다.
// 작업장 대기와 운반 대기, 사고와 고장은 같은 색이고 라벨(과 빗금)로 구분한다.
const STOP = "#8e2e42";
const WAIT = "#898781";
export const LOSS_STATES: StateInfo[] = [
  { state: "rework", name: "재작업", color: "#cf3d0b" },
  { state: "material_wait", name: "자재 대기", color: "#de9644" },
  { state: "labor_wait", name: "인력 대기", color: "#56b6d5" },
  { state: "station_wait", name: "작업장 대기", color: WAIT },
  { state: "transport_wait", name: "운반 대기", color: WAIT, hatch: true },
  { state: "accident_stop", name: "사고 중지", color: STOP },
  { state: "breakdown_stop", name: "고장 중지", color: STOP, hatch: true },
];

/** 나눠 하기(3.0)에서 먼저 끝난 부분이 나머지를 기다리는 상태. 부분 기록에만 있다(배 리드타임에는 없음). 대기 회색 + 빗금, 라벨로 구분 */
export const PAIR_WAIT_STATE: StateInfo = { state: "pair_wait", name: "짝 대기", color: WAIT, hatch: true };

// 리드타임 분해의 아홉 칸. 작업은 작업장 색과 섞이지 않게 짙은 먹색, 운반은 손실이 아니라 옅은 중립색이다.
export const WORK_STATE: StateInfo = { state: "work", name: "작업", color: "#33413a" };
export const TRANSPORT_STATE: StateInfo = { state: "transport", name: "운반", color: "#c3cec6" };
export const LEAD_TIME_STATES: StateInfo[] = [WORK_STATE, TRANSPORT_STATE, ...LOSS_STATES];
export const STATE_INFO: Record<string, StateInfo> = Object.fromEntries(LEAD_TIME_STATES.map((s) => [s.state, s]));

export const COST_ITEMS: { key: string; name: string; note: string }[] = [
  { key: "labor", name: "인건비", note: "대기소 인원 일당 × 60일, 숙련공 할증(배정 인원 일당 +5) 포함" },
  { key: "overtime", name: "잔업수당", note: "잔업한 날마다 배정 인원 일당의 50%" },
  { key: "maintenance", name: "정비비", note: "정비한 공정의 작업장마다 100" },
  { key: "material", name: "자재비", note: "BOM 수량 × 단가" },
  { key: "holding", name: "재고비", note: "창고 재고 금액의 1%/일" },
  { key: "wip", name: "재공비", note: "착수~인도 사이 척당 10/일" },
  { key: "rework", name: "재작업비", note: "불량 1건에 200" },
  { key: "accident", name: "사고", note: "사고 1건에 300" },
  { key: "breakdown", name: "고장 수리비", note: "고장 1건에 150 (작업장, 트랜스포터)" },
  { key: "transporter", name: "트랜스포터", note: "대당 5/일, 정비하면 대당 50" },
  { key: "investment", name: "설비 투자비", note: "증설(정반 300, 크레인 800), 로봇 도입(작업장마다 700), 신공법 도입(공정마다 150)" },
  { key: "research", name: "연구비", note: "대기열에 넣은 연구 비용" },
  { key: "late_penalty", name: "지연 배상", note: "계약금의 3%/일" },
];

export const EVENT_NAME: Record<string, string> = {
  arrival: "입고",
  issue: "출고",
  enter: "투입",
  complete: "완료",
  defect: "불량",
  accident: "사고",
  breakdown: "고장",
  transport_start: "운반",
  transport_end: "도착",
  research_done: "연구",
  delivery: "인도",
};

// 등급 5색: 금 S, 초록 A, 파랑 B, 회청 C, 빨강 F. 글자 대비 4.5 이상,
// 색각 이상(적록·청황) 시뮬레이션에서 등급끼리 최소 ΔE 12.3. S와 F는 이중 테두리와 글(GRADE_NOTE)로도 강조한다.
// S는 밝은 금이라 흰 글자가 안 읽힌다(1.8:1). 먹색 글자를 쓰고(8.2:1), 테두리는 짙은 금으로 윤곽을 잡는다.
export const GRADE_COLOR: Record<string, string> = {
  S: "#f2b705", A: "#1f6b4f", B: "#3b5ba5", C: "#5f6670", F: "#c0262d",
};
/** 등급 바탕 위 글자색. 없으면 흰색. */
export const GRADE_TEXT: Record<string, string> = { S: "#1f2a24" };
/** 종이 위 도장·윤곽에 쓰는 진한 색. 밝은 금은 종이와 대비가 낮다. */
export const GRADE_EDGE: Record<string, string> = { S: "#9a6a00" };

/** 강조하는 등급의 한마디. 색만으로 알리지 않으려고 쓴다. */
export const GRADE_NOTE: Record<string, string> = { S: "목표 초과", F: "목표 미달" };
