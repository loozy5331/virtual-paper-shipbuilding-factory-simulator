// 몰리는 날의 작업 지시(4.31, D78): 조립 현장 배정 관제실에서 재생이 멈추면 뜨는 카드.
// 수업 슬라이드 "해야 할 작업은 많은데 사용할 수 있는 시간이 부족하다!"의 표(4.30 조립 작업 목록을 옮김).
// 그날 아침 조립장에 기다리는 블록마다 남은 기간, 필요 작업시간, 자재 준비, 후행 공정(짝 블록)을 보고
// 직접 대응 공정마다 기다리는 블록 전체의 순서를 정한다(↑↓). 처음 순서는 지금 계획(블록 순서·규칙)대로다.
// 화면은 계산하지 않는다: 상황은 엔진 결과 pending, 정한 순서를 결정 기록으로 다시 돌리는 것은 main.ts가 한다.

import { blockLabel, type Scenario, type Situation, type SituationRow } from "./api";
import { h, mount } from "./dom";
import { STATION_COLOR, STATION_TEXT } from "./labels";

export interface DecisionContext {
  scenario: Scenario;
  situation: Situation;
  busy: boolean;
  onSubmit(orders: Record<string, string[]>): void;
  /** 이후는 묻지 않고 기본 대응(규칙)으로 */
  onAuto(): void;
}

/** 정하는 중인 순서(그날, 공정 → 블록). 다시 그려도 유지한다 */
let draft: { day: number; orders: Record<string, string[]> } | null = null;
let collapsed = false;

const MATE_STATE: Record<string, string> = {
  pending: "앞 공정 중", wait: "대기", in: "작업 중", await_tr: "운반 대기", moving: "운반 중", pair: "도착", merged: "도착", finished: "완료",
};

export function renderDecisionCard(root: HTMLElement, ctx: DecisionContext): void {
  const { scenario, situation: sit } = ctx;
  const name = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const matName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  const asked = Object.entries(sit.stations).filter(([, st]) => st.manual && st.waiting.length);
  if (!draft || draft.day !== sit.day) {
    draft = { day: sit.day, orders: Object.fromEntries(asked.map(([sid, st]) => [sid, st.waiting.map((w) => w.id)])) };
    collapsed = false;
  }
  const orders = draft.orders;
  const redraw = () => renderDecisionCard(root, ctx);
  const move = (sid: string, k: number, d: number) => {
    const list = orders[sid];
    [list[k], list[k + d]] = [list[k + d], list[k]];
    redraw();
  };
  const nextName = (r: SituationRow) => {
    if (r.next === "erection") return name.erection;
    const st = Object.entries(CODE).find(([, code]) => r.next.includes(code))?.[0];
    return `${st ? name[st] : ""} ${r.next}`;
  };
  const mateText = (r: SituationRow) => {
    const done = r.mates.every((m) => ["pair", "merged", "finished"].includes(m.state));
    return done ? h("span", { class: "wl-unblock" }, `이것만 끝나면 ${nextName(r)} 시작`)
      : h("span", null, `${nextName(r)} · 짝 `, r.mates.map((m, i) => `${i ? ", " : ""}${m.id} ${MATE_STATE[m.state] ?? m.state}`).join(""));
  };
  const kitText = (r: SituationRow) => {
    const k = r.kit;
    if (!k || k.state === "ready") return h("td", null, "완료", k ? h("small", null, ` ${matName[k.material]} 작업장에`) : null);
    if (k.state === "in_stock") return h("td", { class: "wl-warm" }, "창고에 있음", h("small", null, ` ${matName[k.material]} · 지게차 운반 대기`));
    if (k.state === "not_ordered") return h("td", { class: "wl-hot" }, "미완료", h("small", null, ` ${matName[k.material]} 발주 전`));
    return h("td", { class: "wl-hot" }, "미완료",
      h("small", null, ` ${matName[k.material]} 창고 ${k.arrival_day}일 입고 예정${k.delayed ? "(지연)" : ""}`));
  };

  if (collapsed) {
    mount(root, h("button", { type: "button", class: "dc-tab", onclick: () => { collapsed = false; redraw(); } },
      `${sit.day}일 아침 작업 지시 대기 중 · 펼치기`));
    return;
  }
  const short = sit.need_mh - sit.capacity_mh;
  const count = asked.reduce((n, [, st]) => n + st.waiting.length, 0);
  mount(root, h("section", { class: "dc-card", role: "dialog", "aria-label": `${sit.day}일 아침 작업 지시` },
    h("header", { class: "dc-head" },
      h("div", null, h("small", null, "작업 지시"), h("h2", null, `${sit.day}일 아침 · 조립장에 블록이 몰렸습니다`)),
      h("button", { type: "button", class: "btn small", title: "모니터를 보며 생각하기(재생은 멈춘 채)", onclick: () => { collapsed = true; redraw(); } }, "접기")),
    h("div", { class: "wl-summary" },
      stat(`${count}건`, "배정 대기 블록"),
      stat(`${fmt(sit.capacity_mh)}H`, "당일 가용 작업시간(조립 인원 × 8시간)"),
      stat(`${fmt(sit.need_mh)}H`, short > 0 ? `필요 작업시간 · ${fmt(short)}H 부족` : "필요 작업시간", short > 0)),
    h("p", { class: "dc-ask" }, "어떤 작업부터 진행해야 할까요? 공정마다 위에서부터 들입니다. 납기, 작업시간, 자재 준비, 후속 공정 영향을 함께 보세요."),
    h("div", { class: "dc-stations" }, asked.map(([sid, st]) => {
      const rowOf = Object.fromEntries(st.waiting.map((w) => [w.id, w]));
      return h("div", { class: "dc-station" },
        h("h3", null, h("span", { class: "wl-station", style: { background: STATION_COLOR[sid], color: STATION_TEXT[sid] } }, name[sid]),
          h("small", null, ` 작업장 ${st.units}곳`,
            st.inside.length ? ` · 작업 중 ${st.inside.map((r) => `${r.id}(${fmt(r.mh)}H 남음)`).join(", ")}` : "")),
        h("table", { class: "plan wl-table" },
          h("thead", null, h("tr", null, h("th", null, "순서"), h("th", null, "작업"), h("th", null, "남은 기간"),
            h("th", null, "필요 작업시간"), h("th", null, "자재 준비"), h("th", null, "후행 공정"))),
          h("tbody", null, orders[sid].map((id, k) => {
            const r = rowOf[id];
            const urgent = r.left_days <= 1;
            return h("tr", { class: urgent ? "urgent" : "" },
              h("td", { class: "wl-order" }, `${k + 1}`,
                h("button", { type: "button", class: "btn small", disabled: ctx.busy || k === 0, "aria-label": `${id} 앞으로`, onclick: () => move(sid, k, -1) }, "↑"),
                h("button", { type: "button", class: "btn small", disabled: ctx.busy || k === orders[sid].length - 1, "aria-label": `${id} 뒤로`, onclick: () => move(sid, k, 1) }, "↓")),
              h("th", null, r.id, h("small", null, ` ${blockLabel(sid, r.no)}`)),
              h("td", { class: urgent ? "wl-hot" : "" }, r.left_days < 0 ? `${-r.left_days}일 지남` : `${r.left_days}일`),
              h("td", null, `${fmt(r.mh)}시간`),
              kitText(r),
              h("td", null, mateText(r)));
          }))));
    })),
    h("footer", { class: "dc-foot" },
      h("button", { type: "button", class: "btn", disabled: ctx.busy, title: "남은 날은 묻지 않고 조립 공정 계획서의 규칙대로 합니다", onclick: ctx.onAuto }, "이후는 기본 대응으로"),
      h("button", { type: "button", class: "btn primary", disabled: ctx.busy, onclick: () => ctx.onSubmit(structuredClone(orders)) },
        ctx.busy ? "지시하는 중…" : "이 순서로 작업 지시"))));
}

/** 카드를 닫는다(다음 물음은 처음 순서부터) */
export function clearDecisionDraft(): void {
  draft = null;
}

function stat(value: string, label: string, warn = false): HTMLElement {
  return h("div", { class: `wl-stat${warn ? " warn" : ""}` }, h("b", null, value), h("small", null, label));
}

function fmt(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** 다음 공정 블록 id("S1-BA2")에서 공정을 읽는다 */
const CODE: Record<string, string> = { sub_assembly: "-SA", block_assembly: "-BA", grand_assembly: "-GA" };
