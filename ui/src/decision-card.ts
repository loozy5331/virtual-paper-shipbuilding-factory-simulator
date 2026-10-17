// 몰리는 날의 조치 요청(4.31·4.32, D78·D79): 조립 현장 배정 관제실에서 재생이 멈추면 뜬다.
// 수업 슬라이드 "해야 할 작업은 많은데 사용할 수 있는 시간이 부족하다!"의 표에, 생산관리자가 고를 수 있는 수단을 붙였다.
//   공정 공통: 블록 배치 정책(지금대로 / 선박 순서 / 납기 빠른 순 / 여유 작은 순 / 작업 짧은 순). 표는 고른 정책의 순서로 보인다
//   블록마다: 조치(없음 / 잔업 / 특근 / 외주 / 지체보상금 감수). 값은 그 공정 비상 예산에서, 남은 예산을 넘는 조치는 고를 수 없다
// 외주는 운반일 때문에 직접 하는 것보다 늦게 끝날 수 있어 "직접 하면 며칠"을 옆에 둔다.
// 4.34(D82, 사용자 "이 선택을 함으로서 결과적으로 작업시간은 어떻게 되고, 납기는 잘 지켜지고, 예산은 얼마나 소진되는지"):
//   카드 맨 위 결과 미리보기(대기 블록이 다 끝나는 날 · 배별 인도 · 비상 예산)가 고를 때마다 바뀐다. 정책 단추마다 그 정책이면 어떻게 되는지,
//   조치는 셀렉트 대신 값이 보이는 단추. 미리보기는 엔진 forecast(그날 그렇게 하고 그 뒤는 기본 대응으로 끝까지)
// 화면은 계산하지 않는다: 상황·순서·견적은 엔진 결과 pending, 정한 것을 결정 기록으로 다시 돌리는 것은 main.ts가 한다.

import { blockLabel, type ActionKind, type Decision, type DispatchRule, type Forecast, type ForecastRow, type Scenario, type Situation, type SituationRow } from "./api";
import { h, mount, s } from "./dom";
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
  // 4.37: 버퍼 영향 한 칸(버퍼 시나리오) 또는 남은 기간
  // 4.37: 자재와 후행(짝)을 짧게(간트 줄 이름 아래), 자세한 것은 마우스를 올리면
  const readyText = (r: SituationRow): { short: string; detail: string; hot: boolean } => {
    const k = r.kit;
    const kit = !k || k.state === "ready" ? null
      : k.state === "in_stock" ? `${matName[k.material]} 창고` : k.state === "not_ordered" ? `${matName[k.material]} 발주 전`
        : `${matName[k.material]} ${k.arrival_day}일 입고`;
    const pairDone = r.mates.every((m) => ["pair", "merged", "finished"].includes(m.state));
    return { short: `${fmt(r.mh)}h · ${kit ?? "자재 ✓"}${pairDone ? " · 끝나면 바로 다음 공정" : ""}`, hot: !!kit,
      detail: `남은 작업 ${fmt(r.mh)}시간 · ${kit ?? "자재 준비됨"} · 다음: ${nextName(r)} · 짝 ${r.mates.map((m) => `${m.id} ${MATE_STATE[m.state] ?? m.state}`).join(", ") || "없음"}` };
  };
  const spentOn = (sid: string) => sit.stations[sid].waiting.reduce((n, r) => n + (d.actions[r.id] ? r.quotes![d.actions[r.id]].cost : 0), 0);

  if (collapsed) {
    mount(root, h("button", { type: "button", class: "dc-tab", onclick: () => { collapsed = false; redraw(); } },
      warnIcon(), `${sit.day}일 아침 조치 요청 · 펼치기`));
    return;
  }
  const short = sit.need_mh - sit.capacity_mh;
  const count = asked.reduce((n, [, st]) => n + st.waiting.length, 0);
  const inYard = asked.reduce((n, [, st]) => n + (st.yard?.length ?? 0), 0);
  mount(root, h("div", { class: "dc-backdrop" }), h("section", { class: "dc-card", role: "dialog", "aria-label": `${sit.day}일 아침 조치 요청` },
    h("header", { class: "dc-head" },
      // 4.37.3(사용자): "조치 요청"(옛 액션 카드), 메시지 앞에 노란 삼각형 경고 기호
      h("div", null, h("small", null, "조치 요청"),
        // 4.36(D84): 버퍼 시나리오는 "블록이 계획보다 늦어 버퍼를 먹을 것 같은 날" 묻는다
        h("h2", { class: "dc-title" }, warnIcon(), sit.ships ? `${sit.day}일 아침 · 블록이 늦어 버퍼를 소모할 것 같습니다` : `${sit.day}일 아침 · 조립장에 블록이 몰렸습니다`),
        // 4.37(사용자 "조치 요청도 가독성이 좋지 않네"): 문제를 그림 한 줄로. 배마다 버퍼 칸, 지금 순서대로면 먹을 칸을 붉게
        sit.ships ? h("div", { class: "dc-bufs" }, Object.entries(sit.ships).map(([sid, sh]) => bufferBar(sid, sh.buffer, sh.over))) : null,
        // 4.37.2: 필요·가용 작업시간은 결과 미리보기의 맨아워 칸으로 옮겼다(버퍼 시나리오). 아니면 여기 한 줄
        sit.ships ? null : h("p", { class: "dc-sub" }, `작업장 앞 ${count}건${inYard ? ` · 적치장 ${inYard}건` : ""} · 오늘 가용 ${fmt(sit.capacity_mh)}H / 필요 ${fmt(sit.need_mh)}H`,
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
          h("span", { class: "dc-step" }, "정책"),
          h("div", { class: "dc-options", role: "radiogroup" },
            ([["keep", `지금대로`, DISPATCH_INFO[st.rule].name], ...Object.entries(DISPATCH_INFO).map(([id, info]) => [id, info.name, null])] as [string, string, string | null][])
              .map(([id, label, sub]) => h("button", {
                type: "button", role: "radio", "aria-checked": String(pol === id), class: `dc-option${pol === id ? " on" : ""}`, disabled: ctx.busy,
                title: id === "keep" ? "지금 정책·순서 그대로" : DISPATCH_INFO[id].note,
                onclick: () => { d.policy[sid] = id as DispatchRule | "keep"; redraw(); },
              }, h("b", null, label, sub ? h("small", null, ` ${sub}`) : null),
              polRows ? optionOutcome(polRows[id as DispatchRule | "keep"], polRows.keep) : h("small", { class: "dc-out dim" }, "…"))))),
        h("div", { class: "dc-step-head" }, h("span", { class: "dc-step" }, "블록별 조치"),
          h("small", { class: "dcg-mh" }, `필요 ${fmt(sit.need_mh)} MH · 가용 ${fmt(sit.capacity_mh)} MH/일${f ? ` · 이 선택의 투입 ${fmt(f.mine.mh)} MH` : ""}`),
          h("small", null, "막대 = 이 선택이면 작업하는 구간(진한 부분은 이미 한 만큼), 세로선 = 블록 납기. 선을 넘으면 노랑(버퍼 소모), 그 배 버퍼까지 넘으면 빨강(납기 지연). 얇은 선은 지금대로의 끝. 숫자는 비상 예산에서 낼 값")),
        // 4.38(사용자 "결과 미리보기 대신 간트, 진행도처럼 채우고, 막대 연장선의 조치로 진행도가 바뀌게"): 블록 진행도 간트
        blockGantt(sit, sid, [...st.inside.map((r) => ({ r, inside: true, ord: "작업 중" })), ...order.map((id, k) => ({ r: rowOf[id], inside: false, ord: `${k + 1}` }))],
          f, fresh, (r, inside) => inside || r.action
            ? h("span", { class: "dc-done" }, r.action ? `${ACTION_INFO[r.action].name}(앞서 지시)` : "작업장 안")
            : actionChips(r, d.actions[r.id], left, ctx.busy, (v) => { if (v) d.actions[r.id] = v; else delete d.actions[r.id]; redraw(); }),
          (r) => readyText(r)));
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
  return h("section", { class: `dc-outcome${fresh ? "" : " loading"}`, "aria-live": "polite" },
    h("div", { class: "dc-outcome-head" }, h("b", null, "이 선택이면"),
      h("small", null, fresh ? "오늘 이렇게 하고 그 뒤는 기본 대응으로 끝까지 돌린 결과 · \"지금대로\"는 오늘 아무것도 바꾸지 않았을 때" : "계산하는 중…")),
    sit.ships ? verdict(sit, m) : null,
    // 4.37.3(사용자): 비상 예산은 판정 띠 바로 아래 한 줄
    h("div", { class: "dc-budget-row" },
        h("small", null, "비상 예산 · 이번에 쓰는 값"),
        stations.map((sid) => {
          const b = budget(sid);
          const after = b.left - b.spend;
          // 4.37.2(사용자 "예산도 구간에 따라 색이 변하도록"): 쓴 비율 50% 미만 초록, 80% 미만 노랑, 그 이상 빨강
          const usedRate = b.total > 0 ? (b.total - after) / b.total : 0;
          const band = usedRate >= 0.8 ? "hi" : usedRate >= 0.5 ? "mid" : "lo";
          return h("div", { class: `dc-gauge-row band-${band}` },
            h("span", null, name[sid]),
            h("div", { class: "dc-gauge", title: `예산 ${fmt(b.total)} 중 앞서 ${fmt(b.total - b.left)}, 이번 ${fmt(b.spend)}` },
              h("i", { class: "used", style: { width: `${pct(b.total - b.left, b.total)}%` } }),
              h("i", { class: "now", style: { width: `${pct(b.spend, b.total)}%` } })),
            h("b", null, b.spend ? `−${fmt(b.spend)}` : "0"), h("small", null, ` 남음 ${fmt(after)} / ${fmt(b.total)} (${Math.round(usedRate * 100)}% 사용)`));
        }),
        m && Object.keys(m.refused).length ? h("small", { class: "dc-note wl-hot" }, `예산을 넘어 받지 않는 조치 ${Object.keys(m.refused).length}건`) : null),
    h("div", { class: "dc-outcome-grid" },
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
          k && k.block_on_time !== m.block_on_time ? ` (지금대로 ${k.block_on_time})` : "") : null)));
}

/** 블록 진행도 간트(4.38): 블록마다 한 줄. 옅은 칸 = 계획(오늘 ~ 블록 납기), 막대 = 이 선택이면 작업하는 구간(엔진 forecast),
 *  작업 중 블록은 이미 한 만큼 진하게. 납기선을 넘는 부분은 노랑(버퍼 소모), 그 배 버퍼보다 더 늦으면 빨강(납기 지연).
 *  막대 아래 얇은 선은 지금대로의 끝. 줄 끝에 조치 단추. 외주는 점선(보낸 날 ~ 돌아온 날) */
type GanttRow = { r: SituationRow; inside: boolean; ord: string };
function blockGantt(sit: Situation, sid: string, rows: GanttRow[], f: Forecast | null, fresh: boolean,
  chips: (r: SituationRow, inside: boolean) => HTMLElement, ready: (r: SituationRow) => { short: string; detail: string; hot: boolean }): HTMLElement {
  const today = sit.day;
  const mine = f?.mine.block_times ?? {}, keep = f?.keep.block_times ?? {};
  const pos = (day: number | null, hr: number | null, hours: number | null, end: boolean) =>
    day === null ? null : day - today + (hr === null ? (end ? 1 : 0) : hr / (hours || 8));
  const span = (b: NonNullable<ForecastRow["block_times"]>[string] | undefined) => {
    if (!b) return null;
    const out = b.unit === null;
    const s0 = out ? (b.start ?? today) - today : pos(b.start, b.start_h, b.day_hours, false);
    const e0 = out ? (b.done_day ?? today) - today + 1 : pos(b.end, b.end_h, b.day_hours, true);
    return s0 === null || e0 === null ? null : { s: s0, e: Math.max(e0, s0 + 0.05), out };
  };
  const ends = rows.flatMap(({ r }) => [span(mine[r.id])?.e ?? 0, span(keep[r.id])?.e ?? 0, r.due - today + 1]);
  const total = Math.max(4, Math.ceil(Math.max(...ends)) + 0.5);
  const x = (v: number) => `${(Math.max(0, Math.min(total, v)) / total) * 100}%`;
  const w = (a: number, b: number) => `${(Math.max(0, Math.min(total, b) - Math.max(0, a)) / total) * 100}%`;
  const bufferOf = (ship: string) => sit.ships?.[ship]?.buffer ?? 0;
  const axis = h("div", { class: "dcg-row dcg-axis" }, h("span", null),
    h("div", { class: "dcg-track" }, Array.from({ length: Math.ceil(total) }, (_, k) =>
      h("span", { class: "dcg-tick", style: { left: x(k), width: x(1) } }, `${today + k}일`))),
    h("span", null));
  return h("div", { class: `dcg${fresh ? "" : " loading"}` }, axis, rows.map(({ r, inside, ord }) => {
    const m = span(mine[r.id]), k = span(keep[r.id]);
    const dueX = r.due - today + 1;
    const late = m ? Math.ceil(m.e - dueX - 1e-9) : 0;                 // 블록 납기를 넘긴 날
    const sev = late <= 0 ? "" : late > bufferOf(r.ship) ? "late" : "warn";
    const rd = ready(r);
    const doneFrac = inside && m && mine[r.id]?.std_mh ? Math.max(0, Math.min(1, 1 - r.mh / mine[r.id]!.std_mh)) : 0;
    const track = h("div", { class: "dcg-track" },
      h("i", { class: "dcg-plan", style: { left: "0%", width: x(dueX) } }),
      h("i", { class: "dcg-due", style: { left: x(dueX) } }));
    if (m) {
      const bar = h("i", { class: `dcg-bar${m.out ? " out" : ""}`, style: { left: x(m.s), width: w(m.s, m.e) },
        title: m.out ? `외주: ${today + Math.floor(m.s)}일에 보내 ${mine[r.id]?.done_day}일에 돌아옴` : `${r.ship} ${r.id} 이 선택이면 ${mine[r.id]?.end}일에 끝남` });
      if (doneFrac > 0) bar.append(h("b", { class: "dcg-progress", style: { width: `${doneFrac * 100}%` } }));
      track.append(bar);
      if (m.e > dueX) track.append(h("i", { class: `dcg-over ${sev}`, style: { left: x(Math.max(dueX, m.s)), width: w(Math.max(dueX, m.s), m.e) } }));
    }
    if (k && m && Math.abs(k.e - m.e) > 0.01) track.append(h("i", { class: "dcg-keep", style: { left: x(k.s), width: w(k.s, k.e) }, title: `지금대로면 ${keep[r.id]?.end ?? keep[r.id]?.done_day}일에 끝남` }));
    return h("div", { class: `dcg-row${sev ? ` sev-${sev}` : ""}${inside ? " inside" : ""}` },
      h("div", { class: "dcg-label", title: rd.detail },
        h("small", { class: "dc-ord" }, ord), h("b", null, `${r.ship} ${blockLabel(sid, r.no)}`),
        h("span", { class: rd.hot ? "dc-hit" : "" }, rd.short),
        sev ? h("em", { class: `dcg-sev ${sev}` }, sev === "late" ? `납기 ${late - bufferOf(r.ship)}일 지연` : `버퍼 ${late}일 소모`) : null),
      track,
      h("div", { class: "dcg-act" }, chips(r, inside)));
  }));
}

/** 경고 기호(4.37.3): 노란 삼각형에 검은 느낌표. 조치가 필요하다는 표시(글자와 함께 쓴다) */
function warnIcon(): SVGElement {
  return s("svg", { class: "dc-warn-icon", viewBox: "0 0 24 22", "aria-hidden": "true" },
    s("path", { d: "M12 1.5 L23 20.5 H1 Z", fill: "#f5c518", stroke: "#1f1f1f", "stroke-width": "1.4", "stroke-linejoin": "round" }),
    s("rect", { x: 10.8, y: 7.5, width: 2.4, height: 7, rx: 1, fill: "#111" }),
    s("circle", { cx: 12, cy: 17.4, r: 1.4, fill: "#111" }));
}

/** 판정 띠(4.37.2, 사용자 "버퍼 소모 -> 노란색, 납기 지연 -> 빨간색"): 이 선택이면 납기를 넘기는 배(빨강), 버퍼만 쓰는 배(노랑) */
function verdict(sit: Situation, m: ForecastRow | undefined): HTMLElement {
  if (!m?.completed) return h("div", { class: "dc-verdict" }, "계산하는 중…");
  const late: string[] = [], used: string[] = [];
  for (const [sid, sh] of Object.entries(sit.ships!)) {
    const c = m.completed[sid];
    if (c === null || c === undefined) continue;
    const u = Math.max(0, c - (sh.due - sh.buffer));
    if (u > sh.buffer) late.push(`${sid} ${u - sh.buffer}일`);
    else if (u > 0) used.push(`${sid} ${u}일`);
  }
  return h("div", { class: "dc-verdict" },
    late.length ? h("span", { class: "v-late" }, h("b", null, "납기 지연"), ` ${late.join(" · ")}`) : null,
    used.length ? h("span", { class: "v-warn" }, h("b", null, "버퍼 소모"), ` ${used.join(" · ")}`) : null,
    !late.length && !used.length ? h("span", { class: "v-ok" }, h("b", null, "버퍼 그대로"), " 모든 배가 계획대로 끝납니다") : null);
}

/** 버퍼 칸(4.36, D84): 배마다 이 선택이면 마친 날과 남는 버퍼(납기 − 마친 날, 고른 버퍼보다 많으면 덤). 넘치면 지연 */
function bufferCell(scenario: Scenario, sit: Situation, m: ForecastRow | undefined, k: ForecastRow | undefined): HTMLElement {
  // 4.37.1: 배마다 버퍼 칸 막대(내 선택 진하게, 지금대로 옅게). 버퍼를 먹은 칸은 황색(주의), 넘친 칸은 빨강(인도 지연, 심각)
  const used = (r: ForecastRow | undefined, sid: string) => {
    const c = r?.completed?.[sid];
    const sh = sit.ships![sid];
    return c === undefined || c === null ? null : Math.max(0, c - (sh.due - sh.buffer));
  };
  return h("div", { class: "dc-out-cell" },
    h("small", null, "배별 버퍼 · 내 선택(위)과 지금대로(아래)"),
    h("div", { class: "dc-bufrows" }, scenario.orders.map((o) => {
      const sh = sit.ships![o.id];
      const now = used(m, o.id), was = used(k, o.id);
      const over = now === null ? 0 : Math.max(0, now - sh.buffer);
      return h("div", { class: "dc-bufrow" },
        h("b", null, o.id),
        h("div", { class: "dc-bufpair" }, cells(sh.buffer, now, false), cells(sh.buffer, was, true)),
        h("span", { class: `dc-bufnote${over ? " late" : now ? " warn" : ""}` },
          now === null ? "…" : over ? `납기 ${over}일 지연` : now ? `버퍼 ${now}일 소모 · ${sh.buffer - now}일 남음` : `버퍼 ${sh.buffer}일 그대로`,
          was !== null && now !== null && was !== now ? h("small", null, ` (지금대로 ${was > sh.buffer ? `납기 ${was - sh.buffer}일 지연` : `${was}일 소모`})`) : null));
    })),
    m ? h("small", { class: "dc-note" }, `블록 납기 ${m.block_on_time}/${m.blocks}`,
      k && k.block_on_time !== m.block_on_time ? ` (지금대로 ${k.block_on_time})` : "") : null);
}

/** 버퍼 칸: 버퍼 일수만큼 칸, 먹은 칸 황색, 넘친 칸 빨강(칸 밖으로 늘어난다) */
function cells(buffer: number, used: number | null, ghost: boolean): HTMLElement {
  const n = Math.max(buffer, used ?? 0);
  return h("span", { class: `dc-cells${ghost ? " ghost" : ""}` }, Array.from({ length: n }, (_, k) =>
    h("i", { class: used === null ? "" : k >= buffer ? "over" : k >= buffer - Math.min(used, buffer) ? "eat" : "" })));
}


/** 정책 단추 아래 한 줄(4.37): 그 공정 정책을 그대로 둘 때와 같으면 "그대로와 같음", 다르면 늦는 배 */
function optionOutcome(r: ForecastRow, keep: ForecastRow): HTMLElement {
  const late = Object.entries(r.late).filter(([, v]) => v > 0);
  const same = JSON.stringify(r.late) === JSON.stringify(keep.late) && r.done_day === keep.done_day;
  if (same) return h("small", { class: "dc-out dim" }, "지금대로와 같음");
  const worse = r.on_time < keep.on_time, better = r.on_time > keep.on_time;
  return h("small", { class: `dc-out${worse ? " bad" : better ? " good" : ""}` },
    late.length ? late.map(([sh, v]) => `${sh} +${v}일`).join(", ") : "모두 납기 내", r.done_day !== keep.done_day ? ` · 끝 ${r.done_day}일` : "");
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

/** 배 버퍼 막대(4.37): 버퍼 칸 수만큼 칸, 지금 순서대로면 먹을 칸은 붉게 */
function bufferBar(sid: string, buffer: number, over: number): HTMLElement {
  return h("span", { class: `dc-buf${over > buffer ? " late" : over ? " hit" : ""}`, title: `${sid} 버퍼 ${buffer}일${over ? `, 지금 순서대로면 ${over}일 소모` : ""}` },
    h("b", null, sid),
    h("span", { class: "dc-buf-cells" }, Array.from({ length: Math.max(buffer, over) }, (_, k) =>
      h("i", { class: k >= buffer ? "over" : k >= buffer - over ? "eat" : "" }))),
    h("small", null, over ? `버퍼 ${buffer}일 중 ${Math.min(over, buffer)}일 소모${over > buffer ? ` · 납기 ${over - buffer}일 지연` : ""}` : `버퍼 ${buffer}일`));
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
