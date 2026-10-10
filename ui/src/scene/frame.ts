// 3D 장면의 한 순간: "오늘 무엇이 어디에 있는가".
// 엔진 결과의 일자별 기록(ships[].daily, stations[].daily, transporters[].daily, workforce, inventory)을 읽어 옮기기만 한다.
// 규칙을 다시 계산하지 않는다. 3D 코드(Three.js)도 모른다.

import type { Config, Crew, Peg, Result, Scenario, ShipState } from "../api";
import { SEA_MATERIALS, SUPPLY_DAYS } from "./layout";

/** 로트가 있는 자리. */
export type Place =
  | "hidden"      // 착수 전
  | "queue"       // 공정 앞 대기 줄 (작업장 대기, 자재 대기, 중지된 작업장 앞)
  | "bench"       // 정반 위 (작업, 재작업, 인력 대기, 중지)
  | "outbound"    // 공정을 끝내고 트랜스포터를 기다림
  | "carried"     // 트랜스포터에 실려 다음 정반으로 가는 중
  | "sea";        // 인도 후 물그릇에 떠 있음

export interface LotView {
  ship: string;
  /** 선종 id(VLCC, CONT, LNG). 배 모양을 고른다(2.1). */
  type: string;
  place: Place;
  station: number;          // 자리의 공정 번호 (0 소조립 … 3 탑재)
  unit: number;             // 정반 위면 작업장 번호(0 = 1호, 1 = 2호). 그 밖에는 0
  slot: number;             // 같은 자리에서의 순서 (우선순위 순)
  /** 나눠 하는 중이면 부분마다 작업장 번호(0 = 1호)와 상태. 먼저 끝난 부분은 pair_wait(짝 대기). 3.0 */
  parts?: { unit: number; state: string }[];
  /** 운반 중이면 이번 운반의 진행률(0~1). 운반이 며칠 걸리면 그 날들을 이어서 센다. */
  travel?: number;
  /** 조립 단계. −2 종이 묶음, −1 평평한 판, 0 굽힌 판, 1 소블록 8개, 2 중블록 4개, 3 대블록 2개, 4 배(D43). 정반 위에서는 진행률만큼 소수가 된다(공정별 FORM). */
  form: number;
  /** 칠한 정도 0~1(4.0: 도장 공정에서 칠한다. 도장을 마친 블록은 1) */
  paint: number;
  state: ShipState;
  late: boolean;
}

/** 작업장 하나(증설하면 공정마다 2개)의 오늘. */
export interface UnitView {
  unit: number;             // 1호, 2호
  ship: string | null;      // 오늘 작업장을 차지한 배 (작업, 재작업, 인력 대기, 중지)
  workers: number;          // 오늘 배정된 인원 (시니어 제외)
  stop: "accident" | "breakdown" | null;
  state: string;
}

/** 공정의 오늘. ship·workers·stop·state는 1호 값이다(3D가 아직 1호만 그린다, 2.0 ⑥에서 units로 옮긴다). */
export interface StationView extends Omit<UnitView, "unit"> {
  id: string;
  name: string;
  /** 숙련공 공정이면 참. 3D는 시니어 소인(흰 띠)으로 그린다. */
  senior: boolean;
  crew: Crew;
  overtime: boolean;
  units: UnitView[];
}

export interface TransporterView {
  id: string;
  /** 4.3(D46): 블록 트랜스포터 한 대 */
  role: "block";
  state: "move" | "idle" | "breakdown_stop";
  ship: string | null;      // 실은 배 (여러 척이면 첫 배)
}

/** 지게차 오늘 일감(4.3): 자재 키트(물류창고 → station 앞) 또는 부재 팔레트(가공 unit호 → 소조립) */
export interface ForkliftJobView {
  kind: "kit" | "pallet";
  ship: string;
  /** 키트는 그 자재를 쓰는 공정, 팔레트는 소조립(공정 번호) */
  station: number;
  /** 팔레트를 실은 가공 작업장(0 = 1호) */
  unit: number;
  /** 키트의 자재 이름(팔레트는 null) */
  material: string | null;
}

export interface ForkliftView {
  id: string;
  state: "move" | "idle" | "breakdown_stop";
  jobs: ForkliftJobView[];
}

export interface ShelfView {
  material: string;
  name: string;
  qty: number;
  nextArrival: number | null;   // 다음 입고일 (오늘 뒤)
  /** 재고를 몫(발주한 배)별로(자재 페깅, 3.1). 합 = qty */
  pegs: Peg[];
}

export interface Delivery {
  /** 입고일(마차가 창고에 닿는 날) */
  day: number;
  /** sea = 종이(철판): 배 → 등대 부두 → 마차, land = 물감·깃발: 산길 마차 */
  route: "sea" | "land";
  items: { material: string; name: string; quantity: number }[];
}

export interface ResearchView {
  current: { name: string; done: number; total: number } | null;
  finished: string[];
}

export interface Frame {
  day: number;
  lots: LotView[];
  stations: StationView[];
  transporters: TransporterView[];
  /** 공용 지게차(4.3, D46): 대마다 오늘 일감 */
  forklifts: ForkliftView[];
  idleWorkers: number;
  /** 오늘까지 인도한 배(시운전을 마치고 선주에게 넘김). 조선소를 떠나 그림에는 없고 화면 오른쪽 위 인도 완료 로그에 남는다 */
  delivered: { ship: string; type: string; day: number; late: number }[];
  /** 오늘 시운전 중인 배(먼바다라 그림에는 없고 화면 오른쪽 아래 말풍선에 뜬다). day는 시운전 며칠째, days는 시운전 일수 */
  seaTrial: { ship: string; type: string; day: number; days: number; state: ShipState }[];
  /** 지게차가 오늘 나르는 부재 팔레트(4.0.2, 4.3부터 지게차 일감에서): 오늘 소조립(정반이나 적치장)에 온 배. unit = 가공 작업장, forklift = 지게차 번호 */
  palletMoves: { ship: string; unit: number; forklift: number }[];
  /** 직종별 쉬는 인원(4.0, D42). 대기소의 모자 색 */
  idleByTrade: Record<string, number>;
  shelves: ShelfView[];
  research: ResearchView;
  /** 오늘 진수하는 배: 어제 탑재를 끝내 오늘 인도된 배와 그 도크(0 = 1호). 현장 3D의 진수 장면용(그림만) */
  launches: { ship: string; unit: number }[];
  /** 오늘 입고(하루의 맨 처음): 자재마다 들어온 양. 납품 마차 장면용(그림만, 3.2) */
  arrivals: Delivery["items"];
  /** 납품: 오늘부터 사흘 뒤까지의 입고. 입고일·길(해상·육로)마다 한 대, 사흘 전부터 보인다 */
  deliveries: Delivery[];
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * 공정마다 조립 단계의 처음과 끝(4.0 공정 그래프). 단계: −2 종이(철판) 묶음, −1 잘라 낸 평평한 판 8장, 0 굽힌 판 8장,
 * 1 소블록 8개, 2 중블록 4개, 3 대블록 2개, 4 배(D43). 절단은 판을 잘라 내고, 가공은 판을 굽히고(곡면), 소조립이 판을 블록으로 세운다.
 * 도장·선행의장은 블록 모양을 바꾸지 않고(칠·배관만), 안벽의장·시운전은 다 된 배다. 표에 없는 공정은 공정 번호를 단계로 쓴다(옛 손 계산용).
 */
export const FORM: Record<string, [number, number]> = {
  cutting: [-2, -1], processing: [-1, 0], sub_assembly: [0, 1], block_assembly: [1, 2], painting: [2, 2], pre_outfitting: [2, 2],
  grand_assembly: [2, 3], erection: [3, 4], quay_outfitting: [4, 4], sea_trial: [4, 4],
};

/**
 * 하루의 앞부분(이 비율)은 준비 시간이다: 사람이 작업장으로 걸어오고, 트랜스포터가 로트를 실으러 온다.
 * 그날 시작한 작업이나 운반은 준비가 끝난 뒤부터 진행한다(도착 전에 일이 진행돼 보이지 않게, 2.1.2).
 */
export const LEAD_IN = 0.3;
const afterLead = (frac: number) => clamp01((frac - LEAD_IN) / (1 - LEAD_IN));

/**
 * day는 1~60(0이면 시작 전), frac은 그날 안에서 흐른 비율(0~1). 멈춰 있으면 1이다.
 * 정반 위 진행률 = 그 공정을 시작한 날부터 지난 날 ÷ 그 공정에 걸린 날(엔진의 spans). 첫날은 준비 시간(LEAD_IN) 뒤부터.
 */
export function buildFrame(result: Result, scenario: Scenario, config: Config, day: number, frac: number): Frame {
  const index = day - 1;
  const stationIds = scenario.stations.map((st) => st.id);
  const stationAt = (id: string | null) => (id === null ? -1 : stationIds.indexOf(id));
  const formOf = (p: number, progress: number) => {
    const [a, b] = FORM[stationIds[p]] ?? [p, p + 1];
    return a + (b - a) * progress;
  };

  const lots: LotView[] = result.ships.map((ship) => {
    // 칠한 정도: 도장을 마쳤으면 1, 도장 정반 위면 진행률(아래에서), 아니면 0
    const ps = ship.spans["painting"];
    const painted = ps && day > ps.end ? 1 : 0;
    const base = { ship: ship.id, type: ship.type, slot: 0, unit: 0, late: ship.late_days > 0, paint: painted };
    if (day <= 0) return { ...base, place: "hidden", station: 0, form: 0, state: "not_started" };
    const rec = ship.daily[index];
    const p = stationAt(rec.station);
    switch (rec.state) {
      case "not_started":
        return { ...base, place: "hidden", station: 0, form: 0, state: rec.state };
      case "done":
        return { ...base, place: "sea", station: stationIds.length - 1, form: 4, paint: 1, state: rec.state };
      case "transport": {
        // 이어진 운반 날들: 첫날은 준비(트랜스포터가 실으러 옴) 뒤부터 움직인다.
        let first = index, last = index;
        while (first > 0 && ship.daily[first - 1].state === "transport") first--;
        while (last + 1 < ship.daily.length && ship.daily[last + 1].state === "transport") last++;
        const into = index === first ? afterLead(frac) : frac;
        const travel = clamp01((index - first + into) / (last - first + 1));
        return { ...base, place: "carried", station: p, form: formOf(p, 1), state: rec.state, travel };
      }
      case "transport_wait":
        return { ...base, place: "outbound", station: p, form: formOf(p, 1), state: rec.state };
      case "material_wait":
      case "station_wait":
        return { ...base, place: "queue", station: p, form: formOf(p, 0), state: rec.state };
      default: {
        // 작업, 재작업, 인력 대기, 중지: 정반 위에 있으면 진행률만큼 다음 단계로 바뀌는 중이다.
        // 나눠 하는 배는 부분이 든 작업장이 여럿이다. 아직 일하는 부분의 첫 작업장을 로트 자리로 삼는다.
        const parts = rec.parts?.map((pt) => ({ unit: pt.unit - 1, state: pt.state }));
        const active = parts?.find((pt) => pt.state !== "pair_wait");
        const unit = active ? active.unit : result.stations[p].units.findIndex((u) => u.daily[index].ship === ship.id);
        if (unit < 0) return { ...base, place: "queue", station: p, form: formOf(p, 0), state: rec.state };
        const span = ship.spans[stationIds[p]];
        // 첫날은 사람이 도착한 뒤(준비 시간 뒤)부터 진행한다.
        const into = span && day === span.start ? afterLead(frac) : frac;
        const progress = span ? clamp01((day - span.start + into) / (span.end - span.start + 1)) : 0;
        const paint = stationIds[p] === "painting" ? progress : base.paint;
        return { ...base, place: "bench", station: p, unit, form: formOf(p, progress), paint, state: rec.state, ...(parts ? { parts } : {}) };
      }
    }
  });

  // 같은 자리에 여럿이면 우선순위 순으로 줄을 세운다.
  const priority = Object.fromEntries(result.ships.map((s) => [s.id, s.priority]));
  const groups = new Map<string, LotView[]>();
  for (const lot of lots) {
    const key = `${lot.place}:${lot.station}`;
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => priority[a.ship] - priority[b.ship]).forEach((lot, i) => { lot.slot = i; });
  }

  const stations: StationView[] = result.stations.map((st) => {
    const units: UnitView[] = st.units.map((u) => {
      const rec = day > 0 ? u.daily[index] : { state: "idle", ship: null, workers: 0 };
      return {
        unit: u.unit,
        ship: rec.ship,
        workers: rec.workers,
        stop: rec.state === "accident_stop" ? "accident" : rec.state === "breakdown_stop" ? "breakdown" : null,
        state: rec.state,
      };
    });
    const { unit: _first, ...first } = units[0];
    return {
      id: st.id,
      name: st.name,
      ...first,
      senior: st.crew === "skilled",
      crew: st.crew,
      overtime: config.stations[st.id].overtime,
      units,
    };
  });

  const transporters: TransporterView[] = result.transporters.map((tr) => {
    const rec = day > 0 ? tr.daily[index] : { state: "idle" as const, ships: [] };
    return { id: tr.id, role: "block", state: rec.state, ship: rec.ships[0] ?? null };
  });
  // 팔레트를 실은 가공 작업장: 그 배가 가공에 있던 마지막 날의 작업장
  const procUnit = (shipId: string) => {
    const ship = result.ships.find((s) => s.id === shipId);
    for (let d = index - 1; ship && d >= 0; d--) if (ship.daily[d]?.station === "processing") return Math.max(0, (ship.daily[d].unit ?? 1) - 1);
    return 0;
  };
  const forklifts: ForkliftView[] = (result.forklifts ?? []).map((fk) => {
    const rec = day > 0 ? fk.daily[index] : { state: "idle" as const, jobs: [] };
    return { id: fk.id, state: rec.state, jobs: rec.jobs.map((j) => ({
      kind: j.kind, ship: j.ship, station: stationIds.indexOf(j.station), unit: j.kind === "pallet" ? procUnit(j.ship) : 0,
      material: j.material ? scenario.materials.find((m) => m.id === j.material)?.name ?? j.material : null })) };
  });

  const stock = day > 0 ? result.inventory_daily[index] : {};
  const shelves: ShelfView[] = scenario.materials.map((m) => {
    const next = result.events.find((ev) => ev.type === "arrival" && ev.material === m.id && ev.day > day);
    const pegs = day > 0 ? result.pegging_daily?.[index]?.[m.id] ?? [] : [];
    return { material: m.id, name: m.name, qty: stock[m.id] ?? 0, nextArrival: next ? next.day : null, pegs };
  });

  const running = result.research.find((r) => r.start <= day && day <= r.end);
  const research: ResearchView = {
    current: running ? { name: running.name, done: day - running.start + 1, total: running.end - running.start + 1 } : null,
    finished: result.research.filter((r) => r.end < day).map((r) => r.name),
  };

  // 진수: 어제가 탑재의 마지막 날이고 오늘은 탑재가 아닌 배(4.0: 안벽의장으로 예인된다)
  const dock = "erection";
  const launches = day >= 2 ? result.ships.flatMap((ship) => {
    const today = ship.daily[index], before = ship.daily[index - 1];
    return before?.station === dock && (before.state === "work" || before.state === "rework") && today?.station !== dock
      ? [{ ship: ship.id, unit: (before.unit ?? 1) - 1 }] : [];
  }) : [];

  // 입고: 그날 들어온 자재를 자재마다 합친다(배마다 따로 발주해도 마차 한 대에 싣는다)
  const itemsOn = (d: number) => scenario.materials.flatMap((m) => {
    const quantity = result.events.filter((ev) => ev.type === "arrival" && ev.day === d && ev.material === m.id)
      .reduce((sum, ev) => sum + (ev.type === "arrival" ? ev.quantity : 0), 0);
    return quantity > 0 ? [{ material: m.id, name: m.name, quantity }] : [];
  });
  const arrivals = day > 0 ? itemsOn(day) : [];
  const deliveries: Delivery[] = [];
  for (let d = Math.max(1, day); d <= Math.min(result.days, day + SUPPLY_DAYS); d++) {
    const items = itemsOn(d);
    const sea = items.filter((it) => SEA_MATERIALS.includes(it.material)), land = items.filter((it) => !SEA_MATERIALS.includes(it.material));
    if (sea.length) deliveries.push({ day: d, route: "sea", items: sea });
    if (land.length) deliveries.push({ day: d, route: "land", items: land });
  }

  return {
    day,
    lots,
    launches,
    arrivals,
    deliveries,
    stations,
    transporters,
    forklifts,
    idleWorkers: day > 0 ? result.workforce.daily[index].idle : result.workforce.pool,
    delivered: result.ships.filter((s) => s.delivered_day !== null && s.delivered_day <= day)
      .map((s) => ({ ship: s.id, type: s.type, day: s.delivered_day!, late: s.late_days }))
      .sort((a, b) => b.day - a.day || a.ship.localeCompare(b.ship)),
    palletMoves: forklifts.flatMap((fk, k) => fk.jobs.filter((j) => j.kind === "pallet").map((j) => ({ ship: j.ship, unit: j.unit, forklift: k }))),
    seaTrial: lots.filter((l) => l.place === "bench" && stationIds[l.station] === "sea_trial").map((l) => {
      const span = result.ships.find((s) => s.id === l.ship)!.spans["sea_trial"];
      return { ship: l.ship, type: l.type, day: day - span.start + 1, days: span.end - span.start + 1, state: l.state };
    }),
    idleByTrade: Object.fromEntries(Object.entries(result.workforce.pools ?? { assembly: result.workforce.pool })
      .map(([t, n]) => [t, day > 0 ? result.workforce.daily[index].trades?.[t]?.idle ?? 0 : n])),
    shelves,
    research,
  };
}
