// 선박별 진행(4.18, D65): 관제실 오른쪽 모니터 [작업 현황 / 선박별] 탭의 "선박별".
// 수주받은 배마다 공정(끝남·진행 중·대기·아직)과 자재(발주 전·발주중·도착·사용중·다 씀, 입고 지연).
// 엔진 결과와 그날 장면(Frame)을 읽어 옮기기만 한다(계산하지 않는다). 오늘까지만 적고 예상 완료일은 적지 않는다.

import type { Result, Scenario, ShipSpec, SimEvent } from "./api";
import { h } from "./dom";
import { PAIR_WAIT_STATE, STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";
import type { Frame, LotView } from "./scene/frame";

type StationStep = "done" | "doing" | "wait" | "todo";
type MaterialStep = "before" | "ordered" | "arrived" | "using" | "used";

const MATERIAL_STEP: Record<MaterialStep, string> = {
  before: "발주 전", ordered: "발주중", arrived: "도착", using: "사용중", used: "다 씀",
};

/** 배 한 척의 공정 q가 오늘 어느 단계인가. 로트 자리(frame)만 본다. */
function stationStep(l: LotView, q: number): StationStep {
  if (l.place === "sea") return "done";
  if (l.place === "hidden") return l.state === "material_wait" && q === l.station ? "wait" : "todo";
  if (q < l.station) return "done";
  if (q > l.station) return "todo";
  if (l.place === "bench") return "doing";
  if (l.place === "queue") return "wait";
  return "done";   // outbound, carried: 이 공정을 끝내고 다음으로 운반
}

export interface ShipBoardOptions {
  /** 배 이름을 누르면 그 배의 블록 위치 상자(자재·블록 추적) */
  onPick: (ship: string) => void;
  /** 추적 중인 배(진하게 표시) */
  track: string | null;
  /** 미리보기의 선박 사양서(공정별 작업량). 옛 회차에는 없을 수 있다 */
  specs?: Record<string, ShipSpec>;
}

export function renderShipBoard(result: Result, scenario: Scenario, frame: Frame, opts: ShipBoardOptions): HTMLElement {
  const day = frame.day;
  const stations = scenario.stations.map((st, q) => ({ st, q })).filter(({ st }) => !st.skipped);
  const today = (ev: SimEvent) => ev.day <= day;
  const events = result.events.filter(today);

  const head = h("tr", null,
    h("th", { class: "sb-ship" }, "배"),
    stations.map(({ st }) => h("th", { class: "sb-st" }, st.name)),
    h("th", { class: "sb-mats" }, "자재"));

  const rows = result.ships.map((s) => {
    const l = frame.lots.find((x) => x.ship === s.id)!;
    const spec = opts.specs?.[s.id];
    // 블록 실습(4.25): 블록이 흩어진 날의 블록 공정은 블록으로 읽는다. 블록을 하나라도 시작했으면 진행 중,
    // 진행률 = (끝낸 블록 + 정반 위 블록의 진행률) ÷ 블록 수, 아직 시작 전인데 블록이 앞에 와 있으면 대기
    const blockCell = (stId: string, q: number): { step: StationStep; k: number; state: string | null; text: string } | null => {
      const list = (result.blocks ?? []).filter((b) => b.ship === s.id && b.station === stId);
      if (!l.inBlocks || !list.length) return null;
      const pcs = frame.pieces.filter((pc) => pc.ship === s.id && pc.station === q);
      const done = list.filter((b) => b.done_day !== null && b.done_day <= day).length;
      const text = `블록 ${done}/${list.length}`;
      if (done === list.length) return { step: "done", k: 1, state: null, text };
      if (list.some((b) => b.start !== null && b.start <= day)) {
        const k = list.reduce((sum, b) => sum + (b.done_day !== null && b.done_day <= day ? 1
          : pcs.find((pc) => pc.id === `${s.id}:b:${b.id}`)?.progress ?? 0), 0) / list.length;
        const bench = pcs.filter((pc) => pc.place === "bench");
        const state = bench.some((pc) => pc.state === "work" || pc.state === "rework") ? null : bench[0]?.state ?? pcs[0]?.state ?? null;
        return { step: "doing", k, state, text };
      }
      const wait = pcs.find((pc) => pc.place === "queue");
      return wait ? { step: "wait", k: 0, state: wait.state, text } : { step: "todo", k: 0, state: null, text };
    };
    const blockCells = stations.map(({ st, q }) => blockCell(st.id, q));
    const steps = stations.map(({ q }, i) => blockCells[i]?.step ?? stationStep(l, q));
    const stateName = (state: string) => (state === "pair_wait" ? PAIR_WAIT_STATE : STATE_INFO[state])?.name;

    const cells = stations.map(({ st }, i) => {
      const step = steps[i];
      const bc = blockCells[i];
      const color = STATION_COLOR[st.id];
      if (step === "done") {
        return h("td", { class: "sb-cell done", title: `${st.name} 끝남${bc ? ` · ${bc.text}` : ""}` },
          h("span", { class: "sb-fill", style: { background: color, color: STATION_TEXT[st.id] ?? "#fff" } }, "✓"));
      }
      if (step === "doing") {
        const k = bc ? bc.k : l.progress ?? 0;
        const work = spec?.stations.find((x) => x.station === st.id)?.work;
        const left = work !== undefined ? Math.max(0, Math.round(work * (1 - k) * 10) / 10) : null;
        const loss = bc ? (bc.state ? stateName(bc.state) ?? null : null) : l.state !== "work" ? STATE_INFO[l.state]?.name : null;
        const title = `${st.name} 진행 중${bc ? ` · ${bc.text}` : ""}${loss ? ` · ${loss}` : ""}${left !== null ? ` · 남은 작업량 약 ${left} 인·일 (전체 ${work})` : ""}`;
        return h("td", { class: `sb-cell doing${loss ? " loss" : ""}`, title },
          h("span", { class: "sb-bar" }, h("i", { style: { width: `${Math.round(k * 100)}%`, background: color } })),
          h("span", { class: "sb-left" }, loss ?? (left !== null ? String(left) : `${Math.round(k * 100)}%`)));
      }
      if (step === "wait") {
        const name = (bc?.state ? stateName(bc.state) : STATE_INFO[l.state]?.name) ?? "대기";
        return h("td", { class: "sb-cell wait", title: `${st.name} 앞에서 ${name}` }, h("span", null, name));
      }
      return h("td", { class: "sb-cell todo", title: `${st.name} 아직` });
    });

    // 자재: 이 배의 BOM에 있는 것만. 출고했으면 사용중(그 공정을 끝냈으면 다 씀), 입고했으면 도착, 발주했으면 발주중
    const bom = scenario.ship_types[s.type]?.bom ?? {};
    const mats = scenario.materials.filter((m) => (bom[m.id] ?? 0) > 0).map((m) => {
      const q = scenario.stations.findIndex((st) => st.material === m.id);
      const issued = events.some((ev) => ev.type === "issue" && ev.ship === s.id && ev.material === m.id);
      const arrived = events.some((ev) => ev.type === "arrival" && ev.ship === s.id && ev.material === m.id);
      const delayed = events.find((ev): ev is Extract<SimEvent, { type: "supply_delay" }> =>
        ev.type === "supply_delay" && ev.ship === s.id && ev.material === m.id);
      const orderDay = s.order_days[m.id];
      const at = stations.findIndex((x) => x.q === q);
      const step: MaterialStep = issued ? (q >= 0 && (at >= 0 ? steps[at] : stationStep(l, q)) === "done" ? "used" : "using")
        : arrived ? "arrived"
        : orderDay !== undefined && orderDay <= day ? "ordered" : "before";
      const late = step === "ordered" && !!delayed;
      const title = `${m.name} ${MATERIAL_STEP[step]}${step === "ordered" ? ` (${orderDay}일 발주)` : ""}${late ? ` · 입고 지연 ${delayed!.days}일` : ""}`;
      return h("span", { class: `sb-mat ${step}${late ? " late" : ""}`, title },
        h("b", null, m.name), MATERIAL_STEP[step], late ? " · 지연" : "");
    });

    const late = l.place === "sea" ? s.late_days > 0 : day > s.due_day;
    const where = l.place === "sea" ? `${s.delivered_day}일 인도`
      : l.place === "hidden" && l.state === "not_started" ? "착수 전" : `납기 ${s.due_day}일`;
    return h("tr", { class: opts.track === s.id ? "tracked" : "" },
      h("th", { class: "sb-ship", scope: "row" },
        h("button", { type: "button", class: "sb-name", title: "누르면 블록 위치와 자재 페깅", onclick: () => opts.onPick(s.id) },
          h("b", null, s.id), h("small", null, s.type_name)),
        h("small", { class: late ? "sb-due late" : "sb-due" }, where, late && l.place !== "sea" ? " · 지연" : "")),
      cells,
      h("td", { class: "sb-mats" }, mats));
  });

  return h("div", { class: "ship-board" },
    h("table", null, h("thead", null, head), h("tbody", null, rows)),
    h("p", { class: "sb-note" },
      h("span", null, h("i", { class: "sb-key done" }), "끝남"),
      h("span", null, h("i", { class: "sb-key doing" }), "진행 중(남은 작업량, 인·일)"),
      h("span", null, h("i", { class: "sb-key wait" }), "대기"),
      h("span", null, h("i", { class: "sb-key todo" }), "아직"),
      h("span", { class: "sb-hint" }, `${day}일까지 · 배 이름을 누르면 자재 페깅`)));
}
