// 3D 장면의 한 순간: "오늘 무엇이 어디에 있는가".
// 엔진 결과의 일자별 기록(ships[].daily, stations[].daily, transporters[].daily, workforce, inventory)을 읽어 옮기기만 한다.
// 규칙을 다시 계산하지 않는다. 3D 코드(Three.js)도 모른다.

import type { Config, Peg, Result, Scenario, ShipState } from "../api";

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
  /** 조립 단계. 0 부재, 1 소블록 12개, 2 중블록 6개, 3 대블록 3개(도장), 4 배. 정반 위에서는 진행률만큼 소수가 된다. */
  form: number;
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
  crew: "normal" | "skilled" | "robot";
  overtime: boolean;
  units: UnitView[];
}

export interface TransporterView {
  id: string;
  state: "move" | "idle" | "breakdown_stop";
  ship: string | null;      // 실은 배 (여러 척이면 첫 배)
}

export interface ShelfView {
  material: string;
  name: string;
  qty: number;
  nextArrival: number | null;   // 다음 입고일 (오늘 뒤)
  /** 재고를 몫(발주한 배)별로(자재 페깅, 3.1). 합 = qty */
  pegs: Peg[];
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
  idleWorkers: number;
  shelves: ShelfView[];
  research: ResearchView;
  /** 오늘 진수하는 배: 어제 탑재를 끝내 오늘 인도된 배와 그 도크(0 = 1호). 현장 3D의 진수 장면용(그림만) */
  launches: { ship: string; unit: number }[];
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

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

  const lots: LotView[] = result.ships.map((ship) => {
    const base = { ship: ship.id, type: ship.type, slot: 0, unit: 0, late: ship.late_days > 0 };
    if (day <= 0) return { ...base, place: "hidden", station: 0, form: 0, state: "not_started" };
    const rec = ship.daily[index];
    const p = stationAt(rec.station);
    switch (rec.state) {
      case "not_started":
        return { ...base, place: "hidden", station: 0, form: 0, state: rec.state };
      case "done":
        return { ...base, place: "sea", station: 3, form: 4, state: rec.state };
      case "transport": {
        // 이어진 운반 날들: 첫날은 준비(트랜스포터가 실으러 옴) 뒤부터 움직인다.
        let first = index, last = index;
        while (first > 0 && ship.daily[first - 1].state === "transport") first--;
        while (last + 1 < ship.daily.length && ship.daily[last + 1].state === "transport") last++;
        const into = index === first ? afterLead(frac) : frac;
        const travel = clamp01((index - first + into) / (last - first + 1));
        return { ...base, place: "carried", station: p, form: p + 1, state: rec.state, travel };
      }
      case "transport_wait":
        return { ...base, place: "outbound", station: p, form: p + 1, state: rec.state };
      case "material_wait":
      case "station_wait":
        return { ...base, place: "queue", station: p, form: p, state: rec.state };
      default: {
        // 작업, 재작업, 인력 대기, 중지: 정반 위에 있으면 진행률만큼 다음 단계로 바뀌는 중이다.
        // 나눠 하는 배는 부분이 든 작업장이 여럿이다. 아직 일하는 부분의 첫 작업장을 로트 자리로 삼는다.
        const parts = rec.parts?.map((pt) => ({ unit: pt.unit - 1, state: pt.state }));
        const active = parts?.find((pt) => pt.state !== "pair_wait");
        const unit = active ? active.unit : result.stations[p].units.findIndex((u) => u.daily[index].ship === ship.id);
        if (unit < 0) return { ...base, place: "queue", station: p, form: p, state: rec.state };
        const span = ship.spans[stationIds[p]];
        // 첫날은 사람이 도착한 뒤(준비 시간 뒤)부터 진행한다.
        const into = span && day === span.start ? afterLead(frac) : frac;
        const progress = span ? clamp01((day - span.start + into) / (span.end - span.start + 1)) : 0;
        return { ...base, place: "bench", station: p, unit, form: p + progress, state: rec.state, ...(parts ? { parts } : {}) };
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
    return { id: tr.id, state: rec.state, ship: rec.ships[0] ?? null };
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

  // 진수: 어제가 탑재의 마지막 날이고 오늘 인도 상태인 배
  const last = scenario.stations[scenario.stations.length - 1].id;
  const launches = day >= 2 ? result.ships.flatMap((ship) => {
    const today = ship.daily[index], before = ship.daily[index - 1];
    return today?.state === "done" && before?.station === last && (before.state === "work" || before.state === "rework")
      ? [{ ship: ship.id, unit: (before.unit ?? 1) - 1 }] : [];
  }) : [];

  return {
    day,
    lots,
    launches,
    stations,
    transporters,
    idleWorkers: day > 0 ? result.workforce.daily[index].idle : result.workforce.pool,
    shelves,
    research,
  };
}
