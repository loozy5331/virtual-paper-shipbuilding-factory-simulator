// 서버 API의 요청과 응답 모양. 엔진(sim.py)이 돌려주는 dict를 그대로 옮겼다.
// 화면은 이 값을 그리기만 하고 직접 계산하지 않는다.

export interface StationConfig {
  workers: number;
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
  due_day: number;
  price: number;
}

export interface Method {
  name: string;
  speed: number;
  defect_rate: number;
}

export interface Scenario {
  days: number;
  stations: StationInfo[];
  materials: MaterialInfo[];
  ship_types: Record<string, ShipType>;
  orders: Order[];
  rules: {
    max_workers_per_station: number;
    methods: Record<string, Method>;
    overtime: { speed: number };
  };
}

export interface ScenarioPayload {
  scenario: Scenario;
  presets: Preset[];
  max_rate: number;
}

export interface Preview {
  stations: Record<string, { rate: number; defect_rate: number }>;
  fixed_costs: { labor: number; maintenance: number };
}

export type ShipState =
  | "work" | "rework" | "material_wait" | "station_wait" | "accident_stop" | "not_started" | "done";

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
  due_day: number;
  price: number;
  start_day: number;
  started_day: number | null;
  delivered_day: number | null;
  late_days: number;
  on_time: boolean;
  lead_time: number;
  breakdown: Record<string, number>;
  segments: Segment[];
  daily: { state: ShipState; station: string | null }[];
}

export interface StationResult {
  id: string;
  name: string;
  rate: number;
  defect_rate: number;
  busy_days: number;
  accident_stop_days: number;
  material_wait_days: number;
  inspections: number;
  passes: number;
  oee: {
    availability: number | null;
    performance: number | null;
    quality: number | null;
    oee: number | null;
  };
}

export type SimEvent =
  | { day: number; type: "arrival"; material: string; quantity: number; ship: string }
  | { day: number; type: "enter" | "complete" | "defect"; ship: string; station: string }
  | { day: number; type: "accident"; station: string; ship: string }
  | { day: number; type: "delivery"; ship: string; late_days: number };

export interface Result {
  days: number;
  qcd: {
    quality: { passes: number; inspections: number; first_pass_yield: number | null };
    cost: { total: number };
    delivery: { on_time: number; ships: number; on_time_rate: number; total_late_days: number };
  };
  status: { delivered: number; in_progress: number; not_started: number; defects: number; accidents: number };
  costs: Record<string, number>;
  total_cost: number;
  revenue: number;
  profit: number;
  ships: ShipResult[];
  stations: StationResult[];
  events: SimEvent[];
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
