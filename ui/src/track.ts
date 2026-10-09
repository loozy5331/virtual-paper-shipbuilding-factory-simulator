// 자재·블록 추적(3.1): 블록이나 선반을 누르면 뜨는 정보 상자. 작업 현황 전경(2D)과 현장(3D)이 함께 쓴다.
// 블록 → 그 배가 지금 어디서 무엇을 하는지, 지나온 길, 그 배 몫 자재(자재 페깅).
// 선반 → 그 자재가 어느 배 몫인지, 다음 입고.
// 엔진 결과와 그날 장면(Frame)을 읽어 글로 옮기기만 한다(계산하지 않는다). 오늘 뒤의 일(언제 끝날지)은 적지 않는다.
// 블록 ID가 생기면(다음 개발) TrackPick의 ship에 block을 더한다.

import type { Peg, Result, Scenario, SimEvent } from "./api";
import { h } from "./dom";
import { STATE_INFO } from "./labels";
import type { Frame, LotView } from "./scene/frame";

export type TrackPick = { kind: "ship"; ship: string } | { kind: "material"; material: string };

export interface TrackActions {
  /** 이 배만 진하게(다른 배는 흐리게). null이면 추적 끄기 */
  track: (ship: string | null) => void;
  /** 그 배의 간트(관제실에서만) */
  gantt?: (ship: string) => void;
  /** 다른 대상의 상자로 바꾼다(선반 상자의 배 이름 등) */
  pick: (pick: TrackPick) => void;
  close: () => void;
}

const owner = (ship: string | null) => (ship ? `${ship} 몫` : "공용");

/** 블록이 지금 있는 곳. 오늘까지의 기록만 쓴다. */
function whereNow(l: LotView, frame: Frame, scenario: Scenario): string {
  const st = scenario.stations[l.station];
  const name = st?.name ?? "";
  const loss = STATE_INFO[l.state]?.name;
  switch (l.place) {
    case "hidden": return "착수 전";
    case "sea": return "인도 완료 · 안벽 앞 바다";
    case "carried": {
      const tr = frame.transporters.find((t) => t.ship === l.ship);
      const next = scenario.stations[l.station + 1]?.name ?? "";
      return `${tr ? `트랜스포터 ${tr.id}` : "트랜스포터"}에 실려 ${next}(으)로 운반 중`;
    }
    case "outbound": return `${name}을 끝내고 공용 적치장에서 운반 대기`;
    case "queue":
      return l.station >= 3 ? `${name} 도크 앞에서 ${loss ?? "대기"}` : `${name} 앞 공용 적치장에서 ${loss ?? "대기"}`;
    case "bench": {
      const place = l.station >= 3 ? "도크" : "작업장";
      if (l.parts && l.parts.length > 1) {
        const parts = l.parts.map((pt) => `${pt.unit + 1}호 ${pt.state === "pair_wait" ? "짝 대기(적치장)" : STATE_INFO[pt.state]?.name ?? "작업"}`);
        return `${name} 나눠 하기 · ${parts.join(", ")}`;
      }
      return `${name} ${l.unit + 1}호 ${place} · ${l.state === "work" ? "작업 중" : loss ?? l.state}`;
    }
  }
}

/** 블록(배) 상자 */
function shipCard(ship: string, result: Result, scenario: Scenario, frame: Frame, actions: TrackActions, tracking: string | null): HTMLElement {
  const s = result.ships.find((x) => x.id === ship)!;
  const l = frame.lots.find((x) => x.ship === ship)!;
  const day = frame.day;

  // 지나온 길: 오늘까지 시작한 공정. 끝난 공정은 기간, 하는 중이면 "n일째"(언제 끝날지는 적지 않는다).
  const done = l.place === "sea" || l.place === "carried" || l.place === "outbound";
  const path = scenario.stations.flatMap((st, p) => {
    const span = s.spans[st.id];
    if (!span || span.start > day) return [];
    const finished = p < l.station || (p === l.station && done) || l.place === "sea";
    return [finished ? `${st.name} ${span.start}~${span.end}일` : `${st.name} ${span.start}일~ (${day - span.start + 1}일째)`];
  });

  // 자재 페깅: 자재마다 이 배가 꺼내 쓴 것(누구 몫을), 창고에 남은 이 배 몫, 들어올 이 배 몫.
  const today = (ev: SimEvent) => ev.day <= day;
  const issues = result.events.filter((ev): ev is Extract<SimEvent, { type: "issue" }> => ev.type === "issue" && today(ev));
  const pegsToday = day > 0 ? result.pegging_daily?.[day - 1] ?? {} : {};
  const matRows = scenario.materials.map((m) => {
    const used = issues.find((ev) => ev.ship === ship && ev.material === m.id);
    const lent = issues.filter((ev) => ev.material === m.id && ev.ship !== ship && ev.from.some((f) => f.ship === ship));
    const onShelf = (pegsToday[m.id] ?? []).find((pg: Peg) => pg.ship === ship)?.quantity ?? 0;
    const coming = result.events.find((ev): ev is Extract<SimEvent, { type: "arrival" }> =>
      ev.type === "arrival" && ev.ship === ship && ev.material === m.id && ev.day > day);
    const bits: string[] = [];
    if (used) {
      const from = used.from.map((f) => (f.ship === ship ? `자기 몫 ${f.quantity}` : `${owner(f.ship)} ${f.quantity} 빌려 씀`)).join(", ");
      bits.push(`${used.day}일 ${used.quantity}개 출고 (${from})`);
    }
    if (onShelf) bits.push(`창고에 ${ship} 몫 ${onShelf}개`);
    for (const ev of lent) bits.push(`${ship} 몫 ${ev.from.find((f) => f.ship === ship)!.quantity}개를 ${ev.ship}이(가) ${ev.day}일에 빌려 감`);
    if (coming) bits.push(`${coming.day}일 입고 예정 ${coming.quantity}개`);
    if (!bits.length) bits.push(used ? "" : "아직 없음");
    return h("li", null, h("b", null, m.name), h("span", null, bits.filter(Boolean).join(" · ")));
  });

  const late = l.place === "sea" ? s.late_days > 0 : day > s.due_day;
  return h("div", { class: "track-card", role: "dialog", "aria-label": `${ship} 블록 위치` },
    h("div", { class: "track-head" },
      h("b", null, `${ship} · ${s.type_name}`), h("span", { class: "track-kind" }, "블록 위치"),
      h("button", { class: "track-x", type: "button", title: "닫기 (Esc)", onclick: actions.close }, "✕")),
    h("dl", null,
      h("dt", null, "지금"), h("dd", null, whereNow(l, frame, scenario)),
      h("dt", null, "지나온 길"), h("dd", null, path.length ? path.join(" → ") : "아직 없음"),
      h("dt", null, "납기"), h("dd", { class: late ? "late" : "" }, `${s.due_day}일${l.place === "sea" ? ` · ${s.delivered_day}일 인도` : ""}${late ? " · 지연" : ""}`)),
    h("div", { class: "track-sub" }, "자재 페깅 (이 배 몫으로 발주한 자재)"),
    h("ul", { class: "track-mats" }, matRows),
    h("div", { class: "track-actions" },
      tracking === ship
        ? h("button", { class: "btn small", type: "button", onclick: () => actions.track(null) }, "추적 끄기")
        : h("button", { class: "btn primary small", type: "button", onclick: () => actions.track(ship) }, "이 배 전부 보기"),
      actions.gantt ? h("button", { class: "btn small", type: "button", onclick: () => actions.gantt!(ship) }, "간트") : null),
    h("p", { class: "track-hint" }, "상자가 떠 있는 동안 재생을 멈춥니다. 재생하면 닫힙니다."));
}

/** 선반(자재) 상자 */
function materialCard(material: string, result: Result, scenario: Scenario, frame: Frame, actions: TrackActions): HTMLElement {
  const m = scenario.materials.find((x) => x.id === material)!;
  const day = frame.day;
  const pegs: Peg[] = day > 0 ? result.pegging_daily?.[day - 1]?.[material] ?? [] : [];
  const total = pegs.reduce((a, pg) => a + pg.quantity, 0);
  const next = result.events.filter((ev): ev is Extract<SimEvent, { type: "arrival" }> => ev.type === "arrival" && ev.material === material && ev.day > day).slice(0, 3);
  const shipBtn = (ship: string | null, text: string) => ship
    ? h("button", { class: "track-link", type: "button", onclick: () => actions.pick({ kind: "ship", ship }) }, text)
    : h("span", null, text);
  return h("div", { class: "track-card", role: "dialog", "aria-label": `${m.name} 자재 페깅` },
    h("div", { class: "track-head" },
      h("b", null, `${m.name} 선반`), h("span", { class: "track-kind" }, "자재 페깅"),
      h("button", { class: "track-x", type: "button", title: "닫기 (Esc)", onclick: actions.close }, "✕")),
    h("dl", null,
      h("dt", null, "재고"), h("dd", null, `${total}개 (공용 재고, 출고 때는 자기 몫 → 공용 → 남의 몫 순)`),
      h("dt", null, "몫"), h("dd", null, pegs.length
        ? pegs.map((pg, i) => h("span", null, i ? " · " : "", shipBtn(pg.ship, `${owner(pg.ship)} ${pg.quantity}`)))
        : "비어 있음"),
      h("dt", null, "다음 입고"), h("dd", null, next.length
        ? next.map((ev, i) => h("span", null, i ? " · " : "", `${ev.day}일 `, shipBtn(ev.ship, `${owner(ev.ship)} ${ev.quantity}`)))
        : "없음")),
    h("p", { class: "track-hint" }, "배 이름을 누르면 그 배의 블록 위치를 봅니다."));
}

export function renderTrackCard(pick: TrackPick, result: Result, scenario: Scenario, frame: Frame, actions: TrackActions, tracking: string | null): HTMLElement {
  return pick.kind === "ship"
    ? shipCard(pick.ship, result, scenario, frame, actions, tracking)
    : materialCard(pick.material, result, scenario, frame, actions);
}
