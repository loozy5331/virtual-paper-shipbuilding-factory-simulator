// 몰리는 날의 액션 카드(4.31·4.32, D78·D79): 조립 현장 배정 관제실에서 재생이 멈추면 뜬다.
// 수업 슬라이드 "해야 할 작업은 많은데 사용할 수 있는 시간이 부족하다!"의 표에, 생산관리자가 고를 수 있는 수단을 붙였다.
//   공정 공통: 블록 배치 정책(지금대로 / 선박 순서 / 납기 빠른 순 / 여유 작은 순 / 작업 짧은 순). 표는 고른 정책의 순서로 보인다
//   블록마다: 조치(없음 / 잔업 / 특근 / 외주 / 지체보상금 감수). 값은 그 공정 비상 예산에서, 남은 예산을 넘는 조치는 고를 수 없다
// 외주는 운반일 때문에 직접 하는 것보다 늦게 끝날 수 있어 "직접 하면 며칠"을 옆에 둔다.
// 4.34(D82, 사용자 "이 선택을 함으로서 결과적으로 작업시간은 어떻게 되고, 납기는 잘 지켜지고, 예산은 얼마나 소진되는지"):
//   카드 맨 위 결과 미리보기(대기 블록이 다 끝나는 날 · 배별 인도 · 비상 예산)가 고를 때마다 바뀐다. 정책 단추마다 그 정책이면 어떻게 되는지,
//   조치는 셀렉트 대신 값이 보이는 단추. 미리보기는 엔진 forecast(그날 그렇게 하고 그 뒤는 기본 대응으로 끝까지)
// 화면은 계산하지 않는다: 상황·순서·견적은 엔진 결과 pending, 정한 것을 결정 기록으로 다시 돌리는 것은 main.ts가 한다.

import { blockLabel, type ActionKind, type Decision, type DispatchRule, type Forecast, type ForecastRow, type Scenario, type Situation, type SituationRow } from "./api";
import { h, mount } from "./dom";
import { DISPATCH_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

export interface DecisionContext {
  scenario: Scenario;
  situation: Situation;
  busy: boolean;
  onSubmit(decision: Omit<Decision, "day">): void;
  /** 이후는 묻지 않고 기본 대응(정책대로) */
  onAuto(): void;
  /** 공정 이름을 눌렀다: 두 모니터를 그 공정 작업장으로 */
  onFocus?(station: string): void;
  /** 고르는 중인 결정의 결과 미리보기(엔진) */
  forecast(decision: Omit<Decision, "day">): Promise<Forecast>;
}

/** 정하는 중인 것(그날). 다시 그려도 유지한다 */
let draft: { day: number; policy: Record<string, DispatchRule | "keep">; actions: Record<string, ActionKind> } | null = null;
let collapsed = false;
/** 결과 미리보기: 마지막으로 받은 것과 그 결정(키), 기다리는 중인 결정 */
let fc: { key: string; data: Forecast } | null = null;
let asking: string | null = null;
let timer = 0;

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
    fc = null;
  }
  const d = draft;
  const redraw = () => renderDecisionCard(root, ctx);
  const decision = (): Omit<Decision, "day"> => ({
    policy: Object.fromEntries(Object.entries(d.policy).filter(([, v]) => v !== "keep")) as Record<string, DispatchRule>,
    actions: { ...d.actions },
  });
  // 결과 미리보기: 고른 것이 바뀌면 잠깐 기다렸다가 엔진에 묻는다(마지막 것만 그린다)
  const key = `${sit.day}|${JSON.stringify(decision())}`;
  if (fc?.key !== key && asking !== key) {
    asking = key;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      ctx.forecast(decision()).then((data) => {
        if (asking !== key) return;
        fc = { key, data };
        asking = null;
        if (root.isConnected && !root.hidden) redraw();
      }).catch(() => { if (asking === key) asking = null; });
    }, 120);
  }
  const f = fc?.data.day === sit.day ? fc.data : null;
  const fresh = fc?.key === key;

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
  const inYard = asked.reduce((n, [, st]) => n + (st.yard?.length ?? 0), 0);
  mount(root, h("div", { class: "dc-backdrop" }), h("section", { class: "dc-card", role: "dialog", "aria-label": `${sit.day}일 아침 액션 카드` },
    h("header", { class: "dc-head" },
      h("div", null, h("small", null, "액션 카드"),
        // 4.36(D84): 버퍼 시나리오는 "블록이 계획보다 늦어 버퍼를 먹을 것 같은 날" 묻는다
        h("h2", null, sit.ships ? `${sit.day}일 아침 · 블록이 늦어 버퍼를 먹을 것 같습니다` : `${sit.day}일 아침 · 조립장에 블록이 몰렸습니다`),
        sit.ships ? h("p", { class: "dc-sub dc-threat" }, Object.entries(sit.ships).map(([sid, sh], i) => h("span", { class: sh.over ? "wl-hot" : "" },
          `${i ? " · " : ""}${sid} 버퍼 ${sh.buffer}일`, sh.over ? `(지금 순서대로면 ${sh.over}일 먹음)` : ""))) : null,
        h("p", { class: "dc-sub" }, `배정 대기 ${count}건${inYard ? `(적치장 ${inYard}건 더)` : ""} · 오늘 가용 ${fmt(sit.capacity_mh)}H · 필요 ${fmt(sit.need_mh)}H`,
          short > 0 ? h("b", { class: "wl-hot" }, ` (${fmt(short)}H 부족)`) : null)),
      h("button", { type: "button", class: "btn small", title: "모니터를 보며 생각하기(재생은 멈춘 채)", onclick: () => { collapsed = true; redraw(); } }, "접기")),
    outcomePanel(scenario, sit, asked.map(([sid]) => sid), name, f, fresh, (sid) => ({ left: sit.stations[sid].budget_left, total: sit.stations[sid].budget, spend: spentOn(sid) })),
    h("div", { class: "dc-stations" }, asked.map(([sid, st]) => {
      const pol = d.policy[sid];
      const rowOf = Object.fromEntries(st.waiting.map((w) => [w.id, w]));
      // 표 순서: 고른 정책의 순서(지금대로면 지금 순서), 지체보상금 감수는 맨 뒤
      const ids = pol === "keep" ? st.waiting.map((w) => w.id) : st.rule_orders[pol];
      const deferred = (id: string) => d.actions[id] === "defer" || rowOf[id].action === "defer";
      const order = [...ids.filter((id) => !deferred(id)), ...ids.filter(deferred)];
      const left = st.budget_left - spentOn(sid);
      const polRows = f?.policies[sid];
      return h("div", { class: "dc-station" },
        h("h3", null, h("button", { type: "button", class: "wl-station dc-focus", title: "모니터로 이 공정 작업장 보기",
          style: { background: STATION_COLOR[sid], color: STATION_TEXT[sid] }, onclick: () => ctx.onFocus?.(sid) }, `${name[sid]} 작업장 보기`),
          // 4.35(D83, 사용자 "해당 작업장에서 작업 예정 혹은 작업 중인 블록만"): 표는 작업 중 + 작업장 앞 적치, 적치장은 한 줄 요약
          h("small", null, st.queue_cap ? ` 작업장 앞 ${st.waiting.length}/${st.queue_cap}개` : ` 작업장 앞 ${st.waiting.length}개`,
            yardText(st.yard ?? []))),
        h("div", { class: "dc-policy" },
          h("span", { class: "field-label" }, "배치 정책"),
          h("div", { class: "dc-options", role: "radiogroup" },
            ([["keep", `지금대로`, DISPATCH_INFO[st.rule].name], ...Object.entries(DISPATCH_INFO).map(([id, info]) => [id, info.name, null])] as [string, string, string | null][])
              .map(([id, label, sub]) => h("button", {
                type: "button", role: "radio", "aria-checked": String(pol === id), class: `dc-option${pol === id ? " on" : ""}`, disabled: ctx.busy,
                title: id === "keep" ? "지금 정책·순서 그대로" : DISPATCH_INFO[id].note,
                onclick: () => { d.policy[sid] = id as DispatchRule | "keep"; redraw(); },
              }, h("b", null, label, sub ? h("small", null, ` ${sub}`) : null),
              polRows ? optionOutcome(polRows[id as DispatchRule | "keep"], f!.keep) : h("small", { class: "dc-out dim" }, "…"))))),
        h("table", { class: "plan wl-table" },
          h("thead", null, h("tr", null, h("th", null, "순서"), h("th", null, "작업"), h("th", null, st.waiting.some((w) => w.over !== undefined) ? "버퍼 소진" : "남은 기간"),
            h("th", null, "필요 작업시간"), h("th", null, "자재"), h("th", null, "후행 공정"), h("th", null, "조치 ", h("small", null, "(숫자 = 비상 예산에서 낼 값)")))),
          h("tbody", null, st.inside.map((r) => h("tr", { class: "dc-inside" },
            h("td", { class: "wl-order" }, "작업 중"),
            h("th", null, r.id, h("small", null, ` ${blockLabel(sid, r.no)}`)),
            r.over !== undefined
              ? h("td", { class: r.over ? "wl-hot" : "" }, r.over ? `${r.ship} ${r.over}일` : "계획 안", h("small", null, ` 블록 납기 ${r.due}일`))
              : h("td", { class: r.left_days <= 1 ? "wl-hot" : "" }, r.left_days < 0 ? `${-r.left_days}일 지남` : `${r.left_days}일`),
            h("td", null, `${fmt(r.mh)}시간 남음`),
            kitCell(r),
            h("td", null, mateText(r)),
            h("td", null, h("span", { class: "dc-done" }, r.action ? `${ACTION_INFO[r.action].name}(앞서 지시)` : "작업장 안")))),
          order.map((id, k) => {
            const r = rowOf[id];
            const urgent = r.left_days <= 1;
            return h("tr", { class: urgent ? "urgent" : "" },
              h("td", { class: "wl-order" }, `${k + 1}`),
              h("th", null, r.id, h("small", null, ` ${blockLabel(sid, r.no)}`)),
              r.over !== undefined
                ? h("td", { class: r.over ? "wl-hot" : "" }, r.over ? `${r.ship} ${r.over}일` : "계획 안", h("small", null, ` 블록 납기 ${r.due}일`))
                : h("td", { class: urgent ? "wl-hot" : "" }, r.left_days < 0 ? `${-r.left_days}일 지남` : `${r.left_days}일`),
              h("td", null, `${fmt(r.mh)}시간`, r.quotes ? h("small", null, ` 직접 ${r.quotes.none.days}일`) : null),
              kitCell(r),
              h("td", null, mateText(r)),
              h("td", null, r.action
                ? h("span", { class: "dc-done" }, `${ACTION_INFO[r.action].name}(앞서 지시)`)
                : actionChips(r, d.actions[id], left, ctx.busy, (v) => { if (v) d.actions[id] = v; else delete d.actions[id]; redraw(); })));
          }))));
    })),
    h("footer", { class: "dc-foot" },
      h("button", { type: "button", class: "btn", disabled: ctx.busy, title: "남은 날은 묻지 않고 정책대로 합니다", onclick: ctx.onAuto }, "이후는 기본 대응으로"),
      h("button", { type: "button", class: "btn primary", disabled: ctx.busy, onclick: () => ctx.onSubmit(decision()) },
        ctx.busy ? "지시하는 중…" : "이대로 작업 지시"))));
}

/** 결과 미리보기: 내 선택(그날 이렇게 하고 그 뒤는 기본 대응)과 지금대로(아무것도 바꾸지 않음)를 세 칸으로 */
function outcomePanel(scenario: Scenario, sit: Situation, stations: string[], name: Record<string, string>, f: Forecast | null, fresh: boolean,
  budget: (sid: string) => { left: number; total: number; spend: number }): HTMLElement {
  const m = f?.mine, k = f?.keep;
  const dayDelta = m && k && m.done_day !== null && k.done_day !== null ? m.done_day - k.done_day : 0;
  const mhDelta = m && k ? m.mh - k.mh : 0;
  return h("section", { class: `dc-outcome${fresh ? "" : " loading"}`, "aria-live": "polite" },
    h("div", { class: "dc-outcome-head" }, h("b", null, "이 선택의 결과 미리보기"),
      h("small", null, fresh ? "오늘 이렇게 하고 그 뒤는 기본 대응으로 끝까지 돌린 결과 · \"지금대로\"는 오늘 아무것도 바꾸지 않았을 때" : "계산하는 중…")),
    h("div", { class: "dc-outcome-grid" },
      h("div", { class: "dc-out-cell" },
        h("small", null, "작업시간 · 작업장 앞 블록이 다 끝나는 날"),
        h("b", { class: "dc-big" }, m?.done_day ? `${m.done_day}일` : "…"),
        k ? h("span", { class: `dc-delta${dayDelta < 0 ? " good" : dayDelta > 0 ? " bad" : ""}` },
          dayDelta ? `지금대로 ${k.done_day}일보다 ${Math.abs(dayDelta)}일 ${dayDelta < 0 ? "빠름" : "늦음"}` : "지금대로와 같음") : null,
        m ? h("small", { class: "dc-note" }, `투입 ${fmt(m.mh)}H${mhDelta ? ` (${mhDelta > 0 ? "+" : ""}${fmt(mhDelta)}H)` : ""}`) : null),
      sit.ships ? bufferCell(scenario, sit, m, k) : h("div", { class: "dc-out-cell" },
        h("small", null, "납기 · 배별 인도"),
        h("div", { class: "dc-ships" }, scenario.orders.map((o) => {
          const late = m?.late[o.id];
          const was = k?.late[o.id];
          return h("span", { class: `dc-ship${late === undefined ? "" : late > 0 ? " late" : " ok"}` },
            h("b", null, o.id), late === undefined ? " …" : late > 0 ? ` +${late}일` : " 납기 내",
            was !== undefined && late !== undefined && was !== late ? h("small", null, ` (지금대로 ${was > 0 ? `+${was}일` : "납기 내"})`) : null);
        })),
        m ? h("small", { class: "dc-note" }, `블록 납기 ${m.block_on_time}/${m.blocks}`,
          k && k.block_on_time !== m.block_on_time ? ` (지금대로 ${k.block_on_time})` : "") : null),
      h("div", { class: "dc-out-cell" },
        h("small", null, "비상 예산 · 이번에 쓰는 값"),
        stations.map((sid) => {
          const b = budget(sid);
          const after = b.left - b.spend;
          return h("div", { class: "dc-gauge-row" },
            h("span", null, name[sid]),
            h("div", { class: "dc-gauge", title: `예산 ${fmt(b.total)} 중 앞서 ${fmt(b.total - b.left)}, 이번 ${fmt(b.spend)}` },
              h("i", { class: "used", style: { width: `${pct(b.total - b.left, b.total)}%` } }),
              h("i", { class: "now", style: { width: `${pct(b.spend, b.total)}%` } })),
            h("b", null, b.spend ? `−${fmt(b.spend)}` : "0"), h("small", null, ` 남음 ${fmt(after)} / ${fmt(b.total)}`));
        }),
        m && Object.keys(m.refused).length ? h("small", { class: "dc-note wl-hot" }, `예산을 넘어 받지 않는 조치 ${Object.keys(m.refused).length}건`) : null)));
}

/** 버퍼 칸(4.36, D84): 배마다 이 선택이면 마친 날과 남는 버퍼(납기 − 마친 날, 고른 버퍼보다 많으면 덤). 넘치면 지연 */
function bufferCell(scenario: Scenario, sit: Situation, m: ForecastRow | undefined, k: ForecastRow | undefined): HTMLElement {
  const left = (r: ForecastRow | undefined, sid: string) => {
    const c = r?.completed?.[sid];
    return c === undefined || c === null ? null : sit.ships![sid].due - c;
  };
  const text = (v: number | null) => v === null ? "…" : v < 0 ? `${-v}일 지연` : `버퍼 ${v}일 남음`;
  return h("div", { class: "dc-out-cell" },
    h("small", null, "납기 · 배별 남는 버퍼(납기 − 마친 날)"),
    h("div", { class: "dc-ships" }, scenario.orders.map((o) => {
      const now = left(m, o.id), was = left(k, o.id);
      const buf = sit.ships![o.id].buffer;
      const cls = now === null ? "" : now < 0 ? " late" : now < buf ? " warn" : " ok";
      return h("span", { class: `dc-ship${cls}`, title: `고른 버퍼 ${buf}일` },
        h("b", null, o.id), ` ${text(now)}`, h("small", null, ` /${buf}일`),
        now !== null && was !== null && now !== was ? h("small", null, ` (지금대로 ${text(was)})`) : null);
    })),
    m ? h("small", { class: "dc-note" }, `블록 납기 ${m.block_on_time}/${m.blocks}`,
      k && k.block_on_time !== m.block_on_time ? ` (지금대로 ${k.block_on_time})` : "") : null);
}

/** 정책 단추 아래 한 줄: 그 정책이면 몰린 블록이 끝나는 날과 늦는 배 */
function optionOutcome(r: ForecastRow, keep: ForecastRow): HTMLElement {
  const late = Object.entries(r.late).filter(([, v]) => v > 0);
  const worse = r.on_time < keep.on_time, better = r.on_time > keep.on_time;
  return h("small", { class: `dc-out${worse ? " bad" : better ? " good" : ""}` },
    `끝 ${r.done_day ?? "-"}일 · `, late.length ? late.map(([s, v]) => `${s} +${v}일`).join(", ") : "모두 납기 내");
}

/** 블록 조치 단추: 값과 걸리는 날을 단추에 보이고, 남은 예산을 넘는 조치는 막는다 */
function actionChips(r: SituationRow, chosen: ActionKind | undefined, left: number, busy: boolean,
  onPick: (v: ActionKind | null) => void): HTMLElement {
  const q = r.quotes!;
  const room = left + (chosen ? q[chosen].cost : 0);
  const sub = (k: ActionKind) => k === "defer" ? "0"
    : k === "outsource" ? `${fmt(q[k].cost)} · ${q[k].back_day}일 복귀` : fmt(q[k].cost);
  return h("div", { class: "dc-chips", role: "radiogroup", "aria-label": `${r.id} 조치` },
    h("button", { type: "button", role: "radio", "aria-checked": String(!chosen), class: `dc-chip${!chosen ? " on" : ""}`, disabled: busy,
      onclick: () => onPick(null) }, "없음"),
    (Object.keys(ACTION_INFO) as ActionKind[]).map((k) => {
      const over = q[k].cost > room + 1e-9;
      return h("button", {
        type: "button", role: "radio", "aria-checked": String(chosen === k), class: `dc-chip${chosen === k ? " on" : ""}`,
        disabled: busy || over,
        title: over ? `남은 예산 ${fmt(room)}으로는 부족합니다` : `${ACTION_INFO[k].note}${q[k].days ? ` · 약 ${q[k].days}일` : ""}`,
        onclick: () => onPick(chosen === k ? null : k),
      }, ACTION_INFO[k].name, h("small", null, sub(k)));
    }));
}

/** 카드를 닫는다(다음 물음은 처음부터) */
export function clearDecisionDraft(): void {
  draft = null;
  fc = null;
  asking = null;
  window.clearTimeout(timer);
}

/** 가공 적치장에서 기다리는 블록 한 줄(4.35): 배별 수 */
function yardText(yard: { id: string; ship: string }[]): string {
  if (!yard.length) return "";
  const by: Record<string, number> = {};
  for (const y of yard) by[y.ship] = (by[y.ship] ?? 0) + 1;
  return ` · 가공 적치장 대기 ${Object.entries(by).map(([sh, n]) => `${sh} ${n}개`).join(", ")}(자리가 나면 정책 순서로 올라옴)`;
}

function pct(v: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0;
}

function fmt(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** 다음 공정 블록 id("S1-BA2")에서 공정을 읽는다 */
const CODE: Record<string, string> = { sub_assembly: "-SA", block_assembly: "-BA", grand_assembly: "-GA" };
