// 몰리는 날의 액션 카드(4.31·4.32, D78·D79): 조립 현장 배정 관제실에서 재생이 멈추면 뜬다.
// 수업 슬라이드 "해야 할 작업은 많은데 사용할 수 있는 시간이 부족하다!"의 표에, 생산관리자가 고를 수 있는 수단을 붙였다.
//   공정 공통: 블록 배치 정책(지금대로 / 선박 순서 / 납기 빠른 순 / 여유 작은 순 / 작업 짧은 순). 표는 고른 정책의 순서로 보인다
//   블록마다: 조치(없음 / 잔업 / 특근 / 외주 / 지체보상금 감수). 값은 그 공정 비상 예산에서, 남은 예산을 넘는 조치는 고를 수 없다
// 외주는 운반일 때문에 직접 하는 것보다 늦게 끝날 수 있어 "직접 하면 며칠"을 옆에 둔다.
// 화면은 계산하지 않는다: 상황·순서·견적은 엔진 결과 pending, 정한 것을 결정 기록으로 다시 돌리는 것은 main.ts가 한다.

import { blockLabel, type ActionKind, type Decision, type DispatchRule, type Scenario, type Situation, type SituationRow } from "./api";
import { h, mount } from "./dom";
import { DISPATCH_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

export interface DecisionContext {
  scenario: Scenario;
  situation: Situation;
  busy: boolean;
  onSubmit(decision: Omit<Decision, "day">): void;
  /** 이후는 묻지 않고 기본 대응(정책대로) */
  onAuto(): void;
}

/** 정하는 중인 것(그날). 다시 그려도 유지한다 */
let draft: { day: number; policy: Record<string, DispatchRule | "keep">; actions: Record<string, ActionKind> } | null = null;
let collapsed = false;

const MATE_STATE: Record<string, string> = {
  pending: "앞 공정 중", wait: "대기", in: "작업 중", await_tr: "운반 대기", moving: "운반 중", pair: "도착", merged: "도착",
  finished: "완료", out: "외주 중",
};
export const ACTION_INFO: Record<ActionKind, { name: string; note: string }> = {
  overtime: { name: "잔업", note: "그 블록을 하는 날 10시간(처리량 1.25배). 잔업 불량·사고 위험" },
  extra: { name: "특근", note: "그 블록을 하는 날 16시간(처리량 2배). 사고 위험이 더 크다" },
  outsource: { name: "외주", note: "블록을 밖으로 보낸다. 우리 정반이 비지만 운반일이 붙어 늦게 돌아올 수 있다" },
  defer: { name: "지체보상금 감수", note: "이 블록을 끝까지 맨 뒤로. 값은 0이지만 늦으면 위약금" },
};

export function renderDecisionCard(root: HTMLElement, ctx: DecisionContext): void {
  const { scenario, situation: sit } = ctx;
  const name = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const matName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  const asked = Object.entries(sit.stations).filter(([, st]) => st.manual && st.waiting.length);
  if (!draft || draft.day !== sit.day) {
    draft = { day: sit.day, policy: Object.fromEntries(asked.map(([sid]) => [sid, "keep"])), actions: {} };
    collapsed = false;
  }
  const d = draft;
  const redraw = () => renderDecisionCard(root, ctx);
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
  const kitCell = (r: SituationRow) => {
    const k = r.kit;
    if (!k || k.state === "ready") return h("td", null, "완료");
    if (k.state === "in_stock") return h("td", { class: "wl-warm" }, "창고에 있음", h("small", null, ` ${matName[k.material]} · 지게차 대기`));
    if (k.state === "not_ordered") return h("td", { class: "wl-hot" }, "미완료", h("small", null, ` ${matName[k.material]} 발주 전`));
    return h("td", { class: "wl-hot" }, "미완료", h("small", null, ` ${matName[k.material]} 창고 ${k.arrival_day}일${k.delayed ? "(지연)" : ""}`));
  };
  const spentOn = (sid: string) => sit.stations[sid].waiting.reduce((n, r) => n + (d.actions[r.id] ? r.quotes![d.actions[r.id]].cost : 0), 0);

  if (collapsed) {
    mount(root, h("button", { type: "button", class: "dc-tab", onclick: () => { collapsed = false; redraw(); } },
      `${sit.day}일 아침 액션 카드 · 펼치기`));
    return;
  }
  const short = sit.need_mh - sit.capacity_mh;
  const count = asked.reduce((n, [, st]) => n + st.waiting.length, 0);
  mount(root, h("section", { class: "dc-card", role: "dialog", "aria-label": `${sit.day}일 아침 액션 카드` },
    h("header", { class: "dc-head" },
      h("div", null, h("small", null, "액션 카드"), h("h2", null, `${sit.day}일 아침 · 조립장에 블록이 몰렸습니다`)),
      h("button", { type: "button", class: "btn small", title: "모니터를 보며 생각하기(재생은 멈춘 채)", onclick: () => { collapsed = true; redraw(); } }, "접기")),
    h("div", { class: "wl-summary" },
      stat(`${count}건`, "배정 대기 블록"),
      stat(`${fmt(sit.capacity_mh)}H`, "당일 가용 작업시간(조립 인원 × 8시간)"),
      stat(`${fmt(sit.need_mh)}H`, short > 0 ? `필요 작업시간 · ${fmt(short)}H 부족` : "필요 작업시간", short > 0)),
    h("p", { class: "dc-ask" }, "공정마다 블록 배치 정책을 고르고, 꼭 필요한 블록에만 조치를 겁니다. 납기, 작업시간, 자재 준비, 후속 공정 영향과 비상 예산을 함께 보세요."),
    h("div", { class: "dc-stations" }, asked.map(([sid, st]) => {
      const pol = d.policy[sid];
      const rowOf = Object.fromEntries(st.waiting.map((w) => [w.id, w]));
      // 표 순서: 고른 정책의 순서(지금대로면 지금 순서), 지체보상금 감수는 맨 뒤
      const ids = pol === "keep" ? st.waiting.map((w) => w.id) : st.rule_orders[pol];
      const deferred = (id: string) => d.actions[id] === "defer" || rowOf[id].action === "defer";
      const order = [...ids.filter((id) => !deferred(id)), ...ids.filter(deferred)];
      const left = st.budget_left - spentOn(sid);
      return h("div", { class: "dc-station" },
        h("h3", null, h("span", { class: "wl-station", style: { background: STATION_COLOR[sid], color: STATION_TEXT[sid] } }, name[sid]),
          h("small", null, st.inside.length ? ` 작업 중 ${st.inside.map((r) => `${r.id}(${fmt(r.mh)}H 남음)`).join(", ")}` : " 작업장 비어 있음"),
          h("span", { class: "dc-budget" }, `비상 예산 ${fmt(left)} / ${fmt(st.budget)} 남음`)),
        h("div", { class: "dc-policy" },
          h("span", { class: "field-label" }, "배치 정책"),
          h("div", { class: "seg", role: "radiogroup" },
            ([["keep", `지금대로(${DISPATCH_INFO[st.rule].name})`], ...Object.entries(DISPATCH_INFO).map(([id, info]) => [id, info.name])] as [string, string][])
              .map(([id, label]) => h("label", { class: "seg-item", title: id === "keep" ? "지금 정책·순서 그대로" : DISPATCH_INFO[id].note },
                h("input", { type: "radio", checked: pol === id, disabled: ctx.busy, onchange: () => { d.policy[sid] = id as DispatchRule | "keep"; redraw(); } }),
                h("span", null, label))))),
        h("table", { class: "plan wl-table" },
          h("thead", null, h("tr", null, h("th", null, "순서"), h("th", null, "작업"), h("th", null, "남은 기간"),
            h("th", null, "필요 작업시간"), h("th", null, "자재"), h("th", null, "후행 공정"), h("th", null, "조치"))),
          h("tbody", null, order.map((id, k) => {
            const r = rowOf[id];
            const urgent = r.left_days <= 1;
            return h("tr", { class: urgent ? "urgent" : "" },
              h("td", { class: "wl-order" }, `${k + 1}`),
              h("th", null, r.id, h("small", null, ` ${blockLabel(sid, r.no)}`)),
              h("td", { class: urgent ? "wl-hot" : "" }, r.left_days < 0 ? `${-r.left_days}일 지남` : `${r.left_days}일`),
              h("td", null, `${fmt(r.mh)}시간`, r.quotes ? h("small", null, ` 직접 ${r.quotes.none.days}일`) : null),
              kitCell(r),
              h("td", null, mateText(r)),
              h("td", null, r.action
                ? h("span", { class: "dc-done" }, `${ACTION_INFO[r.action].name}(앞서 지시)`)
                : actionSelect(r, d.actions[id], left, ctx.busy, (v) => { if (v) d.actions[id] = v; else delete d.actions[id]; redraw(); })));
          }))));
    })),
    h("footer", { class: "dc-foot" },
      h("button", { type: "button", class: "btn", disabled: ctx.busy, title: "남은 날은 묻지 않고 정책대로 합니다", onclick: ctx.onAuto }, "이후는 기본 대응으로"),
      h("button", {
        type: "button", class: "btn primary", disabled: ctx.busy,
        onclick: () => ctx.onSubmit({
          policy: Object.fromEntries(Object.entries(d.policy).filter(([, v]) => v !== "keep")) as Record<string, DispatchRule>,
          actions: { ...d.actions },
        }),
      }, ctx.busy ? "지시하는 중…" : "이대로 작업 지시"))));
}

/** 블록 조치 고르기: 견적(값, 걸리는 날)을 보이고 남은 예산을 넘는 조치는 막는다 */
function actionSelect(r: SituationRow, chosen: ActionKind | undefined, left: number, busy: boolean,
  onPick: (v: ActionKind | null) => void): HTMLElement {
  const q = r.quotes!;
  const room = left + (chosen ? q[chosen].cost : 0);
  const text = (k: ActionKind) => k === "defer" ? ACTION_INFO[k].name
    : k === "outsource" ? `${ACTION_INFO[k].name} ${fmt(q[k].cost)} · ${q[k].back_day}일에 돌아옴(운반 포함 ${q[k].days}일)`
      : `${ACTION_INFO[k].name} ${fmt(q[k].cost)} · ${q[k].days}일`;
  return h("select", {
    class: "dc-action", disabled: busy, "aria-label": `${r.id} 조치`,
    onchange: (e: Event) => onPick(((e.target as HTMLSelectElement).value || null) as ActionKind | null),
  },
  h("option", { value: "", selected: !chosen }, "없음"),
  (Object.keys(ACTION_INFO) as ActionKind[]).map((k) => h("option", {
    value: k, selected: chosen === k, disabled: q[k].cost > room + 1e-9, title: ACTION_INFO[k].note,
  }, text(k))));
}

/** 카드를 닫는다(다음 물음은 처음부터) */
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
