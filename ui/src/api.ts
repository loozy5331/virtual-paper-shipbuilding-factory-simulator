// 서버 API의 요청과 응답 모양. 엔진(sim.py)이 돌려주는 dict를 그대로 옮겼다.
// 화면은 이 값을 그리기만 하고 직접 계산하지 않는다.

export interface StationConfig {
  method: string;
  overtime: boolean;
  maintenance: boolean;
}

export interface ShipConfig {
  priority: number;
  start_day: number;
  order_days: Record<string, number | null>;
}

export interface Config {
  ships: Record<string, ShipConfig>;
  stations: Record<string, StationConfig>;
  pool: number;
  transporters: { count: number; maintenance: boolean };
  research: string[];
  skilled_station: string | null;
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
}

export interface ResearchInfo {
  name: string;
  cost: number;
  days: number;
}

export interface Scenario {
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
    overtime: { speed: number };
  };
  transporter: { max_count: number; capacity: number; lot_weight: number };
  research: Record<string, ResearchInfo>;
  kpi: { revenue: number; profit: number; on_time_rate: number; first_pass_yield: number };
}

export interface ScenarioPayload {
  scenario: Scenario;
  presets: Preset[];
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
  fixed_costs: { labor: number; maintenance: number; transporter: number; research: number };
  research: ResearchSlot[];
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
  started_day: number | null;
  delivered_day: number | null;
  late_days: number;
  on_time: boolean;
  lead_time: number;
  lead_time_parts: Record<string, number>;
  spans: Record<string, { start: number; end: number }>;
  segments: Segment[];
  daily: { state: ShipState; station: string | null }[];
}

export interface StationDay {
  state: string;
  ship: string | null;
  workers: number;
}

export interface StationResult {
  id: string;
  name: string;
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
  | { day: number; type: "enter" | "complete" | "defect"; ship: string; station: string }
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

export const api = {
  scenario: () => request<ScenarioPayload>("/api/scenario"),
  simulate: (config: Config) => post<Result>("/api/simulate", config),
  preview: (config: Config) => post<Preview>("/api/preview", config),
  suggestOrders: (config: Config) =>
    post<{ order_days: Record<string, Record<string, number>> }>("/api/suggest-orders", config),
};
