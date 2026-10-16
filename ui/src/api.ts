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
  /** 호이스트(4.9): 조립 정반 위 천장 크레인(소조립·중조립만). 작업량이 줄고 도입비·정비비·고장 판정이 는다. 없으면 없음 */
  hoist?: boolean;
  /** 공정 여유(4.15, D62): 0~max_days일. 배의 여유 합계만큼 납기가 늦어지고 선가가 하루 1% 준다. 없으면 0 */
  buffer?: number;
  /** 블록 공정의 우선순위 규칙(4.25, D71, 블록 조립 실습만). 없으면 선박 순서 */
  dispatch?: DispatchRule;
}

/** 블록 우선순위 규칙(4.25): 선박 순서 · 납기 빠른 순 · 여유 작은 순 · 작업 짧은 순 */
export type DispatchRule = "ship" | "edd" | "slack" | "spt";

export type Crew = "normal" | "skilled" | "robot" | "trial";

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
  /** 4.13(D59): 역산 발주의 여유일 0~3. 없으면 0. 수주 증가부터 */
  jit_buffer?: number;
  /** 4.14(D60): 자재마다 안전 재고 0·1·2척분. 0인 자재는 빼고 적는다. 수주 증가부터 */
  safety_stock?: Record<string, number>;
  ships: Record<string, ShipConfig>;
  stations: Record<string, StationConfig>;
  /** 4.25(D71, 블록 조립 실습만): 공정 납기(배 → 공정 → 날)와 블록 납기(블록 → 날). 적은 것만 기본값(역산)을 바꾼다 */
  due?: { stations?: Record<string, Record<string, number>>; blocks?: Record<string, number> };
  /** 4.25: 블록 순서. 블록 공정 → 먼저 할 블록 이름 목록(계획 간트에서 끌어 정한다). 없는 블록은 규칙 순으로 뒤에 */
  block_order?: Record<string, string[]>;
  /** 4.26: 블록 착수일(블록 이름 → 그날보다 먼저 들이지 않는 날). 조립 공정 계획서에서 막대를 좌우로 끌어 정한다 */
  block_start?: Record<string, number>;
  /** 대기소 전체 인원. 4.0부터는 pools의 합이다(옛 설정은 조립 인원으로 읽는다) */
  pool: number;
  /** 4.0(D42): 직종별 대기소 인원. 사람은 자기 직종 공정에만 간다. 4.22(D69)부터 시운전도 직종 */
  pools?: Record<string, number>;
  /** 4.3(D46): 블록 트랜스포터 한 대로 고정. count는 옛 설정에서만 읽고 엔진이 쓰지 않는다 */
  transporters: { count?: number; maintenance: boolean };
  /** 4.3(D46): 공용 지게차(자재 키트, 가공 → 소조립 부재 팔레트). 없으면 기본 대수, 정비는 트랜스포터를 따른다 */
  forklifts?: { count: number; maintenance: boolean };
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
  /** 4.0(D41·D42): 앞 공정(모두 마쳐야 들어간다), 직종, 자리(같은 자리면 운반 없이 다음 날), 받는 방법, 나눠 하기 가능 */
  after?: string[];
  trade?: string;
  site?: string;
  arrive?: "crane" | "tow";
  split?: boolean;
  /** 4.9: 호이스트를 달 수 있는 공정(소조립·중조립) */
  hoist?: boolean;
  /** 4.12: 기본 설비 이름(4.12.1, 고장 나는 것). false면 조선소 설비가 없는 공정(시운전, 바다): 고장·정비·미정비 불량이 없다 */
  equipment?: string | false;
  /** 4.4(D47): 이 시나리오가 쓰지 않는 공정(간이공정). 번호는 그대로이고 처음부터 마친 것으로 건너뛴다 */
  skipped?: boolean;
}

export interface TradeInfo {
  name: string;
  max?: number;
  cost_per_team_day?: number;
}

export interface MaterialInfo {
  id: string;
  name: string;
  price: number;
  lead_days: number;
  /** 저가 등급 품목 이름(종이 → 휴지) */
  cheap_name: string;
}

/** 선종의 그림(4.17, D66): 갑판 위 모양, 2D 반 길이, 크기 배율. 화면은 선종 코드가 아니라 이 값으로 그린다 */
export interface ShipLookInfo { deck: "tanker" | "container" | "moss" | "tug" | "bulk" | "pctc" | "lpg"; length: number; size: number }

export interface ShipType {
  name: string;
  /** 4.17(D66): ship_categories의 키(상선·특수선·해양) */
  category?: string;
  /** 4.19(D67): 선종 난이도 1 입문 · 2 표준 · 3 고난도. 시나리오 level은 쓰는 선종의 최고 난이도를 거스르지 않는다 */
  difficulty?: number;
  look?: ShipLookInfo;
  /** 4.17(D64): 선박 사양서 글. delivery는 선종마다 덧붙는 인도 조건(설명) */
  spec?: { summary: string; real: string; build: string; delivery: string[] };
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
  /** 4.3: 고를 수 있는 지게차 대수. 하나뿐이면 고정 */
  forklift_counts?: number[];
  /** 4.22(D69): 시운전 인원을 고정한 분기(간이공정 [1]). 없으면 1~max */
  trial_pools?: number[];
  /** 4.8: 고를 수 있는 블록 트랜스포터 대수. 하나뿐이면 고정 */
  transporter_counts?: number[];
  /** 4.9: 호이스트를 달 수 있는가(수주 증가부터) */
  hoist?: boolean;
  /** 4.13: 역산 발주 여유일을 고를 수 있는가(수주 증가부터) */
  jit_buffer?: boolean;
  /** 4.14: 안전 재고를 둘 수 있는가(수주 증가부터) */
  safety_stock?: boolean;
  /** 4.15: 공정 여유를 둘 수 있는가(기본 반기부터) */
  plan_buffer?: boolean;
}

/** 호이스트(4.9): 작업량 배수, 작업장마다 도입비·정비비, 고장 판정 간격(일한 날) */
export interface HoistInfo { name: string; work_factor: number; install_cost: number; maintenance_cost: number; breakdown_every_busy_days: number; summary: string }

export interface Scenario {
  id: string;
  name: string;
  summary: string;
  options?: ScenarioOptions;
  /** 이 분기에서 새로 열린 옵션(D33 포스트잇). 첫 분기는 안내 문장 */
  unlocks?: string;
  /** 난이도 1~3(옛 분기가 쉽다) */
  level?: number;
  /** 4.25: 사다리 밖 실습("drill") */
  track?: string;
  /** 4.25(D71): 조립 직종 공정을 블록으로 계산하는 실습 */
  block_mode?: boolean;
  /** 4.23: 평가서 뒷장 "선배의 팁"에 적는 이 반기의 고정 팁 */
  tips?: string[];
  /** 계획 기간의 이름. 60일은 이 분기의 작업일로 본다. */
  period: string;
  days: number;
  stations: StationInfo[];
  /** 쓰지 않는 공정 id(간이공정, 4.4) */
  skip?: string[];
  /** 직종(4.0, D42). _comment 같은 밑줄 키는 설명 */
  trades: Record<string, TradeInfo | string>;
  default_pools: Record<string, number | string>;
  materials: MaterialInfo[];
  ship_types: Record<string, ShipType>;
  /** 4.17(D66): 선종 분류. _comment 같은 밑줄 키는 설명 */
  ship_categories?: Record<string, { name: string } | string>;
  /** 4.17(D64): 공통 인도 기준(설명 글, 엔진 규칙 아님) */
  delivery?: { criteria: string[] };
  orders: Order[];
  blocks: Record<string, number>;
  rules: {
    max_workers_per_station: number;
    max_pool: number;
    methods: Record<string, Method>;
    crews: Record<Crew, CrewInfo>;
    overtime: { speed: number };
    hoist: HoistInfo;
    costs: { late_penalty_rate_per_day: number };
  };
  transporter: { max_count: number; default_count?: number; capacity: number; lot_weight: number; roles: "block"[] };
  forklift: { default_count: number; max_count: number; jobs_per_day: number; cost_per_day: number; maintenance_cost: number };
  expansion: { name: string; max_units: number; max_units_by_station?: Record<string, number>; summary: string; cost: Record<string, number> };
  material_grades: Record<"standard" | "cheap", { name: string; price_factor: number; defect_add: number }>;
  research: Record<string, ResearchInfo>;
  ordering: Record<Ordering, { name: string; summary: string; buffer_days?: number; buffer_max?: number }>;
  /** 4.13(D59): 입고 지연이 있는 분기인가. 지연 확률·일수는 supply_delay */
  supply_delays?: boolean;
  supply_delay: { probability: number; days: number };
  /** 4.14(D60): 안전 재고로 고를 수 있는 척분 */
  safety_stock: { levels: number[]; abc: { A: number; B: number } };
  /** 4.15(D62): 공정 여유 상한과 여유 하루의 선가 차감률 */
  plan_buffer: { max_days: number; price_cut_per_day: number };
  kpi: { revenue: number; profit: number; on_time_rate: number; first_pass_yield: number };
}

/** 블록 공정(4.25, D71): 블록 조립 실습에서 조립 직종 공정(소조립 8 · 중조립 4 · PE장 2). 엔진 block_counts와 같은 규칙 */
export function blockStations(scenario: Scenario): { id: string; name: string; count: number }[] {
  if (!scenario.block_mode) return [];
  return activeStations(scenario)
    .filter((st) => st.trade === "assembly" && (scenario.blocks[st.id] ?? 1) > 1)
    .map((st) => ({ id: st.id, name: st.name, count: scenario.blocks[st.id] }));
}

const BLOCK_CODE: Record<string, string> = { sub_assembly: "SA", block_assembly: "BA", grand_assembly: "GA" };
const BLOCK_SHORT: Record<string, string> = { sub_assembly: "소", block_assembly: "중", grand_assembly: "PE" };

/** 블록 이름(엔진 block_id와 같다): S1-SA3 */
export function blockId(ship: string, station: string, no: number): string {
  return `${ship}-${BLOCK_CODE[station] ?? station.slice(0, 2).toUpperCase()}${no}`;
}

/** 화면에 쓰는 짧은 블록 이름: 소3 · 중2 · PE1 */
export function blockLabel(station: string, no: number): string {
  return `${BLOCK_SHORT[station] ?? station}${no}`;
}

/** 이 시나리오가 쓰는 공정(간이공정은 일부가 빠진다, 4.4) */
export function activeStations(scenario: Scenario): StationInfo[] {
  return scenario.stations.filter((st) => !st.skipped);
}

/** 사람을 보내는 직종(쓰는 공정이 있는 직종만)과 그 정보. 4.22부터 시운전도 들어간다 */
export function staffTrades(scenario: Scenario): [string, TradeInfo][] {
  const used = new Set(activeStations(scenario).map((st) => st.trade ?? "assembly"));
  return Object.entries(scenario.trades)
    .filter((e): e is [string, TradeInfo] => !e[0].startsWith("_") && typeof e[1] === "object" && used.has(e[0]));
}

/**
 * 엔진의 complete_config와 같은 기본값으로 설정을 채운다(4.0). 3.x 프리셋·회차를 생산계획서에 그대로 올릴 수 있게.
 * 없는 공정은 표준·잔업 없음·정비, pools가 없으면 pool을 조립 인원으로 읽고 나머지 직종은 default_pools.
 * pools에 빠진 직종(4.21까지의 시운전)도 default_pools(간이공정은 options.trial_pools)로 채운다.
 */
export function completeConfig(config: Config, scenario: Scenario): Config {
  for (const st of scenario.stations) {
    config.stations[st.id] ??= { method: "standard", overtime: false, maintenance: true };
  }
  // 시운전 인원(4.22, D69): 4.21까지 설정에는 없다. 인원을 고정한 분기(간이공정)는 그 값으로 채운다
  const fallback = (t: string): number => {
    if (t === "trial" && scenario.options?.trial_pools?.length) return scenario.options.trial_pools[0];
    const d = scenario.default_pools[t];
    return typeof d === "number" ? d : 1;
  };
  if (!config.pools) {
    config.pools = Object.fromEntries(staffTrades(scenario).map(([t]) => [t, t === "assembly" ? config.pool : fallback(t)]));
  } else {
    for (const [t] of staffTrades(scenario)) config.pools[t] ??= fallback(t);
  }
  config.pool = Object.values(config.pools).reduce((a, b) => a + b, 0);
  config.forklifts ??= { count: scenario.forklift.default_count, maintenance: config.transporters.maintenance };
  config.transporters.count ??= scenario.transporter.default_count ?? 1;   // 4.7 이전 설정은 1대
  return config;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  summary: string;
  period: string;
  /** 난이도. 옛 분기가 쉽다(1부터). 실습은 0 */
  level: number;
  /** 4.25: 사다리 밖 실습이면 "drill"(첫 화면 맨 끝 카드) */
  track?: string;
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
  /** 4.14: 자재마다 안전 재고 수량(척분 × 1척 몫). 두지 않은 자재는 없다 */
  safety_stock: Record<string, number>;
  /** 4.14(D60): 자재 ABC 분석(교육용 표, 규칙에는 쓰지 않는다). 금액 큰 순 누적 비율로 A·B·C, ships = 그 자재를 쓰는 배 수 */
  abc: AbcRow[];
  plan: Plan;
  /** 4.15(D62): 공정 여유를 넣은 납기와 선가(배마다) */
  contract?: Record<string, { due_day: number; price: number; buffer_days: number }>;
  /** 4.17(D64): 선박 사양서. 배마다 쓰는 공정의 작업량(인·일, 호이스트 반영)·직종·자재와 직종별 합계(trial = 시운전팀) */
  ships?: Record<string, ShipSpec>;
  /** 4.25(D71, 블록 조립 실습만): 공정 납기(역산 + 고친 값)와 블록 납기 */
  dues?: { stations: Record<string, Record<string, number>>; blocks: Record<string, number> };
  /** 4.25: 계획 간트(배가 혼자 쓴다고 본 일정)의 공정 끝이 공정 납기를 넘기는 배·공정 */
  plan_risks?: PlanRisk[];
  /** 4.25: 블록 계획 일정(계획 간트에서 펼친 공정의 블록 막대) */
  block_plan?: BlockPlan;
}

export interface PlanRisk { ship: string; station: string; plan_end: number; due: number; days: number }

/** 4.25 블록 계획 일정(엔진 block_plan): 고장·대기 없이 들일 순서대로 놓은 블록 막대 */
/** ready(4.26): 들어갈 수 있게 된 날(앞 블록 끝 다음 날·공정 시작일·착수일). start보다 이르면 그동안 작업장이 차 있었다 */
export interface BlockPlanItem { station: string; ship: string; no: number; ready: number; start: number; end: number; unit: number; due: number; risk: boolean }
export interface BlockPlan { blocks: Record<string, BlockPlanItem>; order: Record<string, string[]>; risks: string[] }

export interface ShipSpec {
  type: string;
  stations: { station: string; trade: string; work: number; material: string | null; quantity: number }[];
  trades: Record<string, number>;
}

export interface AbcRow {
  material: string;
  name: string;
  /** 수주 척수(ships의 분모) */
  of: number;
  quantity: number;
  value: number;
  share: number;
  /** 금액 큰 순으로 이 자재까지의 누적 비율(0~1) */
  cumulative: number;
  class: "A" | "B" | "C";
  ships: number;
  lead_days: number;
  delay: { probability: number; days: number } | null;
}

/** buffer(4.15): 계획 간트에서 이 공정 막대 뒤의 여유일. 여유가 없으면 없다 */
export interface Span { start: number; end: number; buffer?: number }

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
  /** 4.25(D71, 블록 조립 실습만): 공정마다 공정 납기, 마친 날(못 마쳤으면 null), 늦은 날 */
  station_dues?: Record<string, { due: number; end: number | null; late_days: number }>;
  id: string;
  type: string;
  type_name: string;
  order_day: number;
  due_day: number;
  price: number;
  /** 4.15: 공정 여유 합계와 여유를 넣기 전의 납기·선가. 옛 회차에는 없다 */
  buffer_days?: number;
  base_due_day?: number;
  base_price?: number;
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
  /** 4.25(블록 조립 실습): 그날 이 작업장에서 일한 블록(이어 하기로 여럿일 수 있다) */
  blocks?: string[];
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
  /** 나눠 하기에서 먼저 끝난 부분이 나머지를 기다린 날(작업장마다 합). OEE에는 넣지 않는다(3.0) */
  pair_wait_days?: number;
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
  /** 4.3(D46): 블록 트랜스포터 한 대("TR"). 4.2까지는 T1 자재·T2 블록 */
  id: string;
  role: "block";
  moves: number;
  breakdowns: number;
  daily: { state: "move" | "idle" | "breakdown_stop"; ships: string[]; /** 4.25: 그날 실은 블록(블록 조립 실습) */ blocks?: string[] }[];
}

/** 지게차 일감(4.3): 자재 키트(물류창고 → 그 자재를 쓰는 작업장) 또는 부재 팔레트(가공 → 소조립) */
export interface ForkliftJob {
  kind: "kit" | "pallet";
  ship: string;
  /** 키트는 그 자재를 쓰는 공정, 팔레트는 받는 공정(소조립) */
  station: string;
  material?: string;
  /** 팔레트를 실은 공정(가공) */
  from?: string;
}

export interface ForkliftResult {
  id: string;
  moves: number;
  breakdowns: number;
  daily: { state: "move" | "idle" | "breakdown_stop"; jobs: ForkliftJob[] }[];
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
  /** 4.23: S까지 모자란 점수와 가장 많이 남은 항목(다 채웠으면 null). 옛 회차 결과에는 없다 */
  to_s?: { need: number; focus: string | null };
  baseline: { preset: string; name: string; score: number; grade: string; profit: number; pool: number; on_time: number } | null;
  vs_baseline: { profit: number; pool: number; score: number } | null;
}

export type SimEvent =
  | { day: number; type: "arrival"; material: string; quantity: number; ship: string | null; safety?: boolean }
  | { day: number; type: "supply_delay"; material: string; quantity: number; ship: string; days: number; arrival_day: number }
  | { day: number; type: "issue"; material: string; quantity: number; ship: string; station: string; from: Peg[]; transporter?: string | null; forklift?: string }
  | { day: number; type: "enter" | "complete" | "defect"; ship: string; station: string; unit?: number; units?: number[] }
  | { day: number; type: "accident"; station: string; ship: string }
  | { day: number; type: "breakdown"; station?: string; transporter?: string; forklift?: string; ship?: string }
  | { day: number; type: "transport_start" | "transport_end"; ship: string; from: string; to: string }
  | { day: number; type: "research_done"; research: string }
  | { day: number; type: "delivery"; ship: string; late_days: number };

/** 7관리 개선 포인트(4.15). 손실이 있는 요소에만 붙는다. 문구는 화면이 code마다 정한 안내를 쓴다 */
export type MgmtPoint =
  | { code: "conflict"; days: number }
  | { code: "slip"; ship: string; days: number }
  | { code: "station_wait" | "labor_wait" | "transport_wait" | "material_wait"; station: string | null; days: number }
  | { code: "holding"; cost: number }
  | { code: "breakdown" | "overtime"; station: string; days: number }
  | { code: "defect" | "accident"; station: string; count: number };

/** 평가서 부록의 7관리 지표(4.15, D61). 데이터 관리는 평가서 전체라 따로 없다. 등급에는 넣지 않는다 */
export interface Management {
  plan: { on_plan: number; ships: number; slip_days: number; conflict_days: number; point: MgmtPoint | null };
  schedule: { flow_efficiency: number | null; lead_days: number;
    wait_days: { station_wait: number; labor_wait: number; transport_wait: number }; point: MgmtPoint | null };
  material: { wait_days: number; supply_delays: number; avg_inventory: number; holding: number; point: MgmtPoint | null };
  equipment: { oee: number | null; breakdowns: number; stop_days: number; point: MgmtPoint | null };
  quality: { first_pass_yield: number | null; defects: number; rework_days: number; point: MgmtPoint | null };
  safety: { accidents: number; stop_days: number; overtime_days: number; point: MgmtPoint | null };
}

export interface Result {
  days: number;
  qcd: {
    quality: { passes: number; inspections: number; first_pass_yield: number | null };
    cost: { total: number };
    delivery: { on_time: number; ships: number; on_time_rate: number; total_late_days: number };
    /** 4.14 QCDS의 S: 잔업 사고 건수, 사고로 멈춘 날, 잔업한 날(작업장 × 일), 사고 비용. 등급에는 넣지 않는다 */
    safety?: { accidents: number; stop_days: number; overtime_days: number; accident_cost: number };
  };
  status: {
    delivered: number; in_progress: number; not_started: number;
    defects: number; accidents: number; breakdowns: number;
  };
  costs: Record<string, number>;
  total_cost: number;
  revenue: number;
  profit: number;
  workforce: { pool: number; pools?: Record<string, number>; man_days: number; idle_man_days: number; utilization: number;
    daily: { assigned: number; idle: number; trades?: Record<string, { assigned: number; idle: number }> }[] };
  ships: ShipResult[];
  stations: StationResult[];
  transporters: TransporterResult[];
  forklifts: ForkliftResult[];
  research: ResearchSlot[];
  inventory_daily: Record<string, number>[];
  /** 그날 끝의 창고 재고를 몫(발주한 배)별로. 몫이 null이면 공용(처음 재고). 먼저 들어온 몫이 앞(자재 페깅, 3.1) */
  pegging_daily: Record<string, Peg[]>[];
  inventory_value_daily: number[];
  events: SimEvent[];
  findings: Finding[];
  grade: Grade;
  /** 4.15 7관리 지표. 옛 회차 결과에는 없다 */
  management?: Management;
  /** 4.25(D71, 블록 조립 실습만): 블록마다 작업장·완료일·납기·하루 상태 */
  blocks?: BlockResult[];
  /** 4.25(D71, 블록 조립 실습만): 블록 납기 요약 */
  block_due?: { blocks: number; on_time: number; rate: number | null; late_days: number };
  /** 4.25: 평가서 선배의 팁의 우선순위 추천. 블록 순서를 비우고 규칙만 바꿔 더 돌린 네 결과와 지금 계획 */
  recommend?: Recommend;
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

/** 자재 페깅(3.1): 어느 배 몫의 자재가 몇 개인가. ship이 null이면 공용 */
export interface Peg {
  ship: string | null;
  quantity: number;
}

/** 추천이 비교하는 네 숫자(4.25): 인도 납기 준수 척 수, 블록 납기 준수율, 이익, 직행률 */
export interface DispatchMetrics { on_time: number; block_rate: number | null; profit: number; first_pass_yield: number | null }
export interface Recommend {
  rules: (DispatchMetrics & { rule: DispatchRule })[];
  best: DispatchRule;
  current: DispatchMetrics & { rules: Record<string, DispatchRule>; block_order?: boolean };
  current_is_best: boolean;
}

export interface BlockResult {
  id: string; ship: string; station: string; no: number; unit: number | null; start: number | null; end: number | null;
  done_day: number | null; defect: boolean; due: number; late_days: number; on_time: boolean;
  daily: { state: string; unit: number | null }[];
}
