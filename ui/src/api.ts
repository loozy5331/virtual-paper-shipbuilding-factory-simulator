// 서버 API의 요청과 응답 모양. 엔진(sim.py)이 돌려주는 dict를 그대로 옮겼다.
// 화면은 이 값을 그리기만 하고 직접 계산하지 않는다.

export interface StationConfig {
  method: string;
  overtime: boolean;
  maintenance: boolean;
  /** 작업장 수(2.0 증설). 없으면 1. */
  units?: number;
  /** 인력(2.0 4M): normal 일반, skilled 숙련공, robot 로봇. 없으면 일반. */
  crew?: Crew;
  /** 나눠 하기(3.0): 배 한 척의 작업량을 빈 작업장 여러 곳에 나눈다. 없으면 끔. 탑재는 나누지 않는다. */
  split?: boolean;
}

export type Crew = "normal" | "skilled" | "robot";

export interface ShipConfig {
  priority: number;
  start_day: number;
  /** 1.0 설정에서만 쓴다. 1.1부터는 ordering을 고르면 엔진이 정한다. */
  order_days?: Record<string, number | null>;
}

export type Ordering = "bulk" | "jit" | "late";

export interface Config {
  /** 시나리오 id(2.0). 없으면 기본 분기. */
  scenario?: string;
  ordering?: Ordering;
  ships: Record<string, ShipConfig>;
  stations: Record<string, StationConfig>;
  pool: number;
  transporters: { count: number; maintenance: boolean };
  research: string[];
  /** 1.x 설정의 시니어. 2.0부터는 공정의 crew = "skilled"로 쓴다(엔진이 둘 다 읽는다). */
  skilled_station?: string | null;
  /** 자재 등급(2.0 4M): 자재 id → standard 표준 | cheap 저가. 없으면 표준. */
  materials?: Record<string, "standard" | "cheap">;
}

export interface Preset {
  id: string;
  name: string;
  summary: string;
  config: Config;
}

export interface StationInfo {
  id: string;
  name: string;
  real: string;
  material: string | null;
}

export interface MaterialInfo {
  id: string;
  name: string;
  price: number;
  lead_days: number;
  /** 저가 등급 품목 이름(종이 → 휴지) */
  cheap_name: string;
}

export interface ShipType {
  name: string;
  work: Record<string, number>;
  bom: Record<string, number>;
}

export interface Order {
  id: string;
  type: string;
  order_day: number;
  due_day: number;
  price: number;
}

export interface Method {
  name: string;
  speed: number;
  defect_rate: number;
  /** 신공법: 로트를 끝낼 때마다 불량률이 이만큼 줄어 defect_floor에서 멈춘다. */
  learning_step?: number;
  defect_floor?: number;
  setup_cost?: number;
  summary?: string;
}

export interface CrewInfo {
  name: string;
  summary: string;
  defect_add?: number;
  install_cost?: number;
}

export interface ResearchInfo {
  name: string;
  cost: number;
  days: number;
  /** 연구가 끝난 다음 날부터 나는 효과(scenario.json의 문구). */
  effect: string;
}

/** 분기(난이도)가 열어 둔 옵션(D33). 생산계획서는 여기 없는 옵션을 그리지 않고, 엔진은 거절한다. */
export interface ScenarioOptions {
  crews: Crew[];
  methods: string[];
  material_grades: string[];
  max_units: number;
  split: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  summary: string;
  options?: ScenarioOptions;
  /** 이 분기에서 새로 열린 옵션(D33 포스트잇). 첫 분기는 안내 문장 */
  unlocks?: string;
  /** 난이도 1~3(옛 분기가 쉽다) */
  level?: number;
  /** 계획 기간의 이름. 60일은 이 분기의 작업일로 본다. */
  period: string;
  days: number;
  stations: StationInfo[];
  materials: MaterialInfo[];
  ship_types: Record<string, ShipType>;
  orders: Order[];
  blocks: Record<string, number>;
  rules: {
    max_workers_per_station: number;
    max_pool: number;
    methods: Record<string, Method>;
    crews: Record<Crew, CrewInfo>;
    overtime: { speed: number };
  };
  transporter: { max_count: number; capacity: number; lot_weight: number };
  expansion: { name: string; max_units: number; summary: string; cost: Record<string, number> };
  material_grades: Record<"standard" | "cheap", { name: string; price_factor: number; defect_add: number }>;
  research: Record<string, ResearchInfo>;
  ordering: Record<Ordering, { name: string; summary: string }>;
  kpi: { revenue: number; profit: number; on_time_rate: number; first_pass_yield: number };
}

export interface ScenarioSummary {
  id: string;
  name: string;
  summary: string;
  period: string;
  /** 난이도. 옛 분기가 쉽다(1부터). */
  level: number;
  ships: number;
  /** 선종 이름 → 척수 */
  ship_mix: Record<string, number>;
  kpi: { revenue: number; profit: number; on_time_rate: number; first_pass_yield: number };
  days: number;
}

export interface ScenarioPayload {
  version: string;
  scenario: Scenario;
  presets: Preset[];
  scenarios: ScenarioSummary[];
  max_rate: number;
}

export interface ResearchSlot {
  id: string;
  name: string;
  cost: number;
  start: number;
  end: number;
  effective_from: number;
  done: boolean;
}

export interface Preview {
  stations: Record<string, { rate: number; defect_rate: number; defect_rate_final: number }>;
  fixed_costs: { labor: number; maintenance: number; transporter: number; investment: number; research: number };
  research: ResearchSlot[];
  /** 배별 자재의 발주일과 입고일. 엔진이 발주 방식에 따라 정한다. */
  materials: Record<string, Record<string, { order_day: number | null; arrival_day: number | null }>>;
  plan: Plan;
}

export interface Span { start: number; end: number }

/** 계획 막대: 배가 작업장을 혼자 쓴다고 본 공정 일정과, 두 배가 같은 작업장을 겹쳐 쓰는 구간. */
export interface Plan {
  ships: Record<string, Record<string, Span>>;
  conflicts: { station: string; ships: [string, string]; start: number; end: number }[];
}

export type ShipState =
  | "work" | "rework" | "material_wait" | "station_wait" | "labor_wait"
  | "transport" | "transport_wait" | "accident_stop" | "breakdown_stop"
  | "not_started" | "done";

export interface Segment {
  state: ShipState;
  station: string;
  start: number;
  end: number;
}

export interface ShipResult {
  id: string;
  type: string;
  type_name: string;
  order_day: number;
  due_day: number;
  price: number;
  priority: number;
  start_day: number;
  order_days: Record<string, number>;
  arrival_days: Record<string, number>;
  started_day: number | null;
  delivered_day: number | null;
  late_days: number;
  on_time: boolean;
  lead_time: number;
  lead_time_parts: Record<string, number>;
  spans: Record<string, { start: number; end: number }>;
  segments: Segment[];
  /** parts: 나눠 하는 동안 부분(작업장)마다 상태(3.0). 먼저 끝난 부분은 pair_wait */
  daily: { state: ShipState; station: string | null; unit?: number | null; parts?: { unit: number; state: string }[] }[];
}

export interface StationDay {
  state: string;
  ship: string | null;
  workers: number;
}

export interface StationResult {
  id: string;
  name: string;
  /** 인력(2.0 4M) */
  crew: Crew;
  max_rate: number;
  defect_rate: number;
  busy_days: number;
  accident_stop_days: number;
  breakdown_stop_days: number;
  material_wait_days: number;
  labor_wait_days: number;
  breakdowns: number;
  inspections: number;
  passes: number;
  oee: {
    availability: number | null;
    performance: number | null;
    quality: number | null;
    oee: number | null;
  };
  /** 작업장별 기록(2.0 증설). daily는 1호와 같다. */
  units: { unit: number; busy_days: number; breakdowns: number; daily: StationDay[] }[];
  daily: StationDay[];
}

export interface TransporterResult {
  id: string;
  moves: number;
  breakdowns: number;
  daily: { state: "move" | "idle" | "breakdown_stop"; ships: string[] }[];
}

export interface Finding {
  kind: ShipState;
  ship: string;
  station: string;
  start: number;
  end: number;
  days: number;
}

export interface GradePart {
  key: string;
  name: string;
  value: number;
  target: number;
  max: number;
  points: number;
}

export interface Grade {
  score: number;
  grade: string;
  parts: GradePart[];
  baseline: { preset: string; name: string; score: number; grade: string; profit: number; pool: number; on_time: number } | null;
  vs_baseline: { profit: number; pool: number; score: number } | null;
}

export type SimEvent =
  | { day: number; type: "arrival"; material: string; quantity: number; ship: string }
  | { day: number; type: "issue"; material: string; quantity: number; ship: string; station: string }
  | { day: number; type: "enter" | "complete" | "defect"; ship: string; station: string; unit?: number; units?: number[] }
  | { day: number; type: "accident"; station: string; ship: string }
  | { day: number; type: "breakdown"; station?: string; transporter?: string; ship?: string }
  | { day: number; type: "transport_start" | "transport_end"; ship: string; from: string; to: string }
  | { day: number; type: "research_done"; research: string }
  | { day: number; type: "delivery"; ship: string; late_days: number };

export interface Result {
  days: number;
  qcd: {
    quality: { passes: number; inspections: number; first_pass_yield: number | null };
    cost: { total: number };
    delivery: { on_time: number; ships: number; on_time_rate: number; total_late_days: number };
  };
  status: {
    delivered: number; in_progress: number; not_started: number;
    defects: number; accidents: number; breakdowns: number;
  };
  costs: Record<string, number>;
  total_cost: number;
  revenue: number;
  profit: number;
  workforce: { pool: number; man_days: number; idle_man_days: number; utilization: number; daily: { assigned: number; idle: number }[] };
  ships: ShipResult[];
  stations: StationResult[];
  transporters: TransporterResult[];
  research: ResearchSlot[];
  inventory_daily: Record<string, number>[];
  inventory_value_daily: number[];
  events: SimEvent[];
  findings: Finding[];
  grade: Grade;
}

export class ApiError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join("; "));
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(["서버에 연결할 수 없습니다. python server/app.py 가 켜져 있는지 확인하세요."]);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.errors ?? [`서버 오류 (${response.status})`]);
  }
  return body as T;
}

function post<T>(path: string, config: Config): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
}

/** 수업용 저장(2.0 ⑤): 반의 시나리오별 최고 회차 */
export interface ClassBest {
  grade: string;
  score: number;
  profit: number;
  nickname: string;
  on_time: number;
  ships: number;
  players?: number;
}

export interface Leaderboard {
  class_code: string;
  best: Record<string, ClassBest>;
}

export interface SavedRun {
  id: number;
  nickname: string;
  class_code: string;
  scenario: string;
  grade: string;
  score: number;
  profit: number;
}

export const api = {
  saveRun: (nickname: string, classCode: string, config: Config) => request<SavedRun>("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname, class_code: classCode, config }),
  }),
  leaderboard: (classCode: string) => request<Leaderboard>(`/api/leaderboard?class=${encodeURIComponent(classCode)}`),
  scenario: (id = "basic") => request<ScenarioPayload>(`/api/scenario?id=${encodeURIComponent(id)}`),
  simulate: (config: Config) => post<Result>("/api/simulate", config),
  preview: (config: Config) => post<Preview>("/api/preview", config),
};
