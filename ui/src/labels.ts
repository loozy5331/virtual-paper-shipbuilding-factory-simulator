// 화면에 쓰는 이름과 색. 색은 색각 이상 검증기를 통과한 값이다(CLAUDE.md 참고).
// 색만으로 구분하지 않도록, 색을 쓰는 곳에는 항상 라벨이나 범례를 함께 둔다.

export const STATION_COLOR: Record<string, string> = {
  cutting: "#2a78d6",
  gluing: "#e87ba4",
  painting: "#008300",
  outfitting: "#4a3aa7",
};

// 막대 안 글자색. 풀칠 분홍은 밝아서 흰 글자가 안 읽히므로 어두운 글자를 쓴다.
export const STATION_TEXT: Record<string, string> = {
  cutting: "#ffffff",
  gluing: "#1f2a24",
  painting: "#ffffff",
  outfitting: "#ffffff",
};

export interface StateInfo {
  state: string;
  name: string;
  color: string;
}

export const LOSS_STATES: StateInfo[] = [
  { state: "rework", name: "재작업", color: "#ec835a" },
  { state: "material_wait", name: "자재 대기", color: "#fab219" },
  { state: "station_wait", name: "작업장 대기", color: "#898781" },
  { state: "accident_stop", name: "사고 중지", color: "#d03b3b" },
];

// 리드타임 분해의 다섯 칸. 작업은 작업장 색과 섞이지 않게 짙은 먹색으로 둔다.
export const BREAKDOWN_STATES: StateInfo[] = [
  { state: "work", name: "작업", color: "#33413a" },
  ...LOSS_STATES,
];

export const COST_ITEMS: { key: string; name: string; note: string }[] = [
  { key: "labor", name: "인건비", note: "작업자 일당 × 60일, 숙련공 수당 포함" },
  { key: "overtime", name: "잔업수당", note: "잔업일마다 일당의 50%" },
  { key: "maintenance", name: "정비비", note: "정비한 작업장마다 100" },
  { key: "material", name: "자재비", note: "BOM 수량 × 단가" },
  { key: "holding", name: "재고비", note: "창고 재고 금액의 1%/일" },
  { key: "wip", name: "재공비", note: "착수~인도 사이 척당 10/일" },
  { key: "rework", name: "재작업비", note: "불량 1건에 200" },
  { key: "accident", name: "사고", note: "사고 1건에 300" },
  { key: "late_penalty", name: "지연 배상", note: "계약금의 3%/일" },
];

export const EVENT_NAME: Record<string, string> = {
  arrival: "입고",
  enter: "투입",
  complete: "완료",
  defect: "불량",
  accident: "사고",
  delivery: "인도",
};
