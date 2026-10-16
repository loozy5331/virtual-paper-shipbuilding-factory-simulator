// 블록 계획 간트(4.25, D71·D72): 조립 공정 계획서(PP-02)의 배 탭에 그린다. 막대는 엔진이 준 블록 계획 일정(block_plan,
// 고장·대기 없음)이고, 세로 눈금은 블록 납기다. 막대 끝이 눈금을 넘으면 계획상 위험(붉은 테두리와 "!").
// 4.26(사용자 2026-10-16): 관제실 간트의 공정 탭처럼 블록 공정마다
//   위: 작업장마다 한 줄. 이 배의 블록은 공정 색(블록 이름), 다른 배의 블록은 회색이라 "다른 배 블록을 하느라 늦는다"가 보인다.
//   아래: 이 배의 블록마다 한 줄(블록 번호 순, 착수일을 바꿔도 줄은 그대로). 들어갈 수 있는데 작업장이 차서 기다린 날은 얇은 띠.
// 4.29(D76): 막대의 자리와 길이는 시간이다(하루 칸 = 계획 근무 8시간, 엔진이 준 start_h·end_h). 작업장 줄도 블록마다 그 시간만큼 그린다.
// 막대를 좌우로 끌어 그 블록의 착수일(block_start)과 착수 시각(block_start_hour)을 1시간 단위로 정한다. Alt+←/→는 1시간,
// Shift+Alt+←/→는 하루씩이다. 끌 수 있는 범위는 생산계획서 계획 간트의
// 그 배 그 공정 시작일부터 공정 납기까지(4.27.1 사용자 "가": 공정 기간만으로는 막대가 띠를 꽉 채워 움직일 데가 없다)이고 옅은 띠로
// 보인다(계획 공정 기간은 조금 진하게). 막대가 띠 밖에 있으면 지금 자리까지 넓힌다(끌 때 막대가 반대쪽으로 튀지 않게).
// 화면은 계산하지 않는다: 착수일을 바꾸면 미리보기가 새 막대를 준다(작업장이 차 있으면 정한 날보다 늦게 놓일 수 있다).

import { blockLabel, dayHour, type BlockPlan, type BlockPlanItem, type Scenario, type Span } from "./api";
import { h, s } from "./dom";
import { STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

const W = 640;   // 조립 공정 계획서 폭에서 거의 1:1로 그려진다(글자·줄이 커지지 않게)
const LEFT = 64;
const RIGHT = 10;
const TOP = 20;
const ROW_H = 11;    // 블록 줄
const UNIT_H = 12;   // 작업장 줄
const HEAD_H = 13;   // 공정 이름 줄
const GAP = 3;       // 작업장 줄과 블록 줄 사이
const BAR_H = 7;
const OTHER = "#d3dbd6";   // 관제실 간트의 다른 배와 같은 회색
const WAIT = STATE_INFO.station_wait;

export interface BlockGanttContext {
  scenario: Scenario;
  plan: BlockPlan;
  ship: string;
  stations: { id: string; name: string }[];
  /** 공정마다 작업장 수 */
  units: Record<string, number>;
  /** 생산계획서 계획 간트의 이 배 공정 기간(끌 수 있는 범위의 시작) */
  windows: Record<string, Span | undefined>;
  /** 이 배의 공정 납기(끌 수 있는 범위의 끝, 공정 기간보다 이르면 공정 기간 끝) */
  dues: Record<string, number | undefined>;
  /** 착수일을 정한 블록(블록 이름 → 날) */
  starts: Record<string, number>;
  /** 착수 시각을 정한 블록(블록 이름 → 근무 시작부터 몇 시간 뒤, 4.29). 없으면 0 */
  startHours: Record<string, number>;
  /** 블록 하나의 착수일과 착수 시각을 정했다 */
  onMoveStart(block: string, day: number, hour: number): void;
}

/** 블록 막대가 하는 시간(4.29): 계획은 시작하면 쉬지 않고 이어 한다 */
function hoursOf(b: BlockPlanItem): number {
  return (b.end - b.start) * b.day_hours + b.end_h - b.start_h;
}

const num = (v: number) => String(Math.round(v * 10) / 10);

let focusedBlock: string | null = null;

/** 블록 일정 범례(4.29.1 사용자): 공정 색 = 이 배의 블록, 회색 = 다른 배, 진한 회색 = 작업장 대기, 띠·눈금·테두리 */
export function blockGanttLegend(stations: { id: string; name: string }[]): HTMLElement {
  const item = (mark: HTMLElement, text: string) => h("span", null, mark, text);
  return h("div", { class: "legend block-legend" },
    stations.map((st) => item(h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
    item(h("i", { style: { background: OTHER } }), "다른 배 블록"),
    item(h("i", { class: "wait-mark", style: { background: WAIT.color } }), "작업장 대기"),
    h("span", { class: "sep" }),
    item(h("i", { class: "window-mark" }), "옮길 수 있는 범위"),
    item(h("i", { class: "due-mark" }), "블록 납기"),
    item(h("i", { class: "pinned-mark" }), "착수를 정한 블록"),
    item(h("i", { class: "risk-mark" }), "계획상 위험"));
}

export function renderBlockGantt(ctx: BlockGanttContext): SVGElement {
  const { plan, ship } = ctx;
  const items = Object.entries(plan.blocks);
  // 공정마다 이 배의 블록(블록 번호 순)과 그 공정의 모든 블록(작업장 줄)
  const groups = ctx.stations.map((st) => ({
    st, win: ctx.windows[st.id], until: Math.max(ctx.windows[st.id]?.end ?? 0, ctx.dues[st.id] ?? 0), n: Math.max(1, ctx.units[st.id] ?? 1),
    all: items.map(([, b]) => b).filter((b) => b.station === st.id),
    ids: items.filter(([, b]) => b.station === st.id && b.ship === ship).sort(([, a], [, b]) => a.no - b.no).map(([id]) => id),
  }));
  const mine = groups.flatMap((g) => g.ids.map((id) => plan.blocks[id]));
  const wins = groups.flatMap((g) => (g.win ? [g.win] : []));
  const first = Math.max(1, Math.min(...mine.map((b) => Math.min(b.ready, b.start)), ...wins.map((w) => w.start)) - 1);
  const last = Math.min(ctx.scenario.days, Math.max(...mine.map((b) => Math.max(b.end, b.due)), ...groups.map((g) => g.until)) + 1);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const HOURS = Object.values(plan.blocks)[0]?.day_hours ?? 8;   // 계획 근무시간(정규 8)
  const hourW = dayW / HOURS;
  /** 그날 근무 시작부터 h시간 뒤의 자리 */
  const at = (day: number, h: number) => x(day) + h * hourW;
  /** 1일 0시간부터 센 시간 ↔ (날, 시간) */
  const abs = (day: number, h: number) => (day - 1) * HOURS + h;
  const height = TOP + groups.reduce((h, g) => h + HEAD_H + g.n * UNIT_H + GAP + g.ids.length * ROW_H, 0) + 4;

  const svg = s("svg", { class: "gantt block-gantt", viewBox: `0 0 ${W} ${height}`, role: "list",
    "aria-label": `${ship} 블록 일정. 막대를 좌우로 끌거나 Alt+←/→로 블록의 착수일을 정합니다(옅은 띠 안에서).` });
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 3, y2: height - 2, class: d % 5 === 0 ? "grid major" : "grid" }));
    if (span <= 30 || d % 5 === 0 || d === first) axis.append(s("text", { x: x(d) + dayW / 2, y: TOP - 7, class: "tick" }, d));
    // 반나절(4시간) 눈금: 막대 길이가 시간이라 하루 칸 안의 자리를 읽게
    if (d < last && dayW >= 16) axis.append(s("line", { x1: x(d) + dayW / 2, x2: x(d) + dayW / 2, y1: TOP - 1, y2: height - 2, class: "grid hour" }));
  }
  svg.append(axis);

  let y = TOP;
  for (const { st, win, until, n, all, ids } of groups) {
    svg.append(s("text", { x: 4, y: y + HEAD_H - 3, class: "block-group" }, st.name));
    svg.append(s("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "block-group-line" }));
    y += HEAD_H;

    // 작업장 줄(4.29): 블록마다 그 시간만큼. 이어 하기라 한 블록이 끝난 자리에서 다음 블록이 시작한다.
    // 이 배의 블록은 공정 색(블록 이름), 다른 배의 블록은 회색(배 이름)
    for (let u = 1; u <= n; u++) {
      const uy = y + (u - 1) * UNIT_H;
      const g = s("g", { class: "unit-row" });
      g.append(s("text", { x: 14, y: uy + UNIT_H - 3, class: "lane-id" }, `${u}호 작업장`),
        s("rect", { x: LEFT, y: uy + 1.5, width: span * dayW, height: UNIT_H - 3, class: "lane" }));
      for (const b of all.filter((b) => b.unit === u && b.end >= first && b.start <= last)) {
        const me = b.ship === ship;
        const bx = Math.max(LEFT, at(b.start, b.start_h));
        const bw = Math.max(1, Math.min(at(b.end, b.end_h), LEFT + span * dayW) - bx);
        const label = me ? blockLabel(st.id, b.no) : b.ship;
        g.append(s("rect", { x: bx, y: uy + 2.5, width: bw, height: UNIT_H - 5, rx: 1, fill: me ? STATION_COLOR[st.id] : OTHER, class: "unit-bar" },
          s("title", null, `${u}호 작업장 · ${me ? "" : "다른 배 "}${b.ship} ${blockLabel(st.id, b.no)} ${dayHour(b.start, b.start_h)} ~ ${dayHour(b.end, b.end_h)} · 표준 ${num(b.std_mh)} MH`)));
        if (bw >= label.length * 5 + 2) {
          g.append(s("text", { x: bx + bw / 2, y: uy + UNIT_H - 3.5, class: "unit-label", fill: me ? STATION_TEXT[st.id] ?? "#fff" : "#4b5a51" }, label));
        }
      }
      svg.append(g);
    }
    y += n * UNIT_H + GAP;

    // 끌 수 있는 범위: 이 공정 블록 줄 뒤에 옅은 공정 색 띠. 계획 공정 기간은 조금 진하게, 그 뒤 공정 납기까지는 더 옅게
    if (win) {
      svg.append(s("rect", {
        x: x(win.start), y, width: (win.end - win.start + 1) * dayW, height: ids.length * ROW_H, rx: 2,
        fill: STATION_COLOR[st.id], class: "block-window",
      }, s("title", null, `${st.name} 블록을 옮길 수 있는 범위 ${win.start}~${until}일 중 생산계획서 계획 간트의 ${ship} ${st.name} 공정 기간 ${win.start}~${win.end}일`)));
      if (until > win.end) {
        svg.append(s("rect", {
          x: x(win.end + 1), y, width: (until - win.end) * dayW, height: ids.length * ROW_H, rx: 2,
          fill: STATION_COLOR[st.id], class: "block-window extra",
        }, s("title", null, `${st.name} 블록을 옮길 수 있는 범위 ${win.start}~${until}일 중 공정 기간 뒤 공정 납기(${until}일)까지`)));
      }
    }
    ids.forEach((id, i) => {
      const b = plan.blocks[id];
      const len = hoursOf(b);
      const x0 = at(b.start, b.start_h);
      const x1 = at(b.end, b.end_h);
      // 막대를 시간 단위로 옮긴다(1일 0시간부터 센 시간). 지금 자리 = 막대가 놓인 시각(시간 단위로 내림)
      const now = abs(b.start, Math.floor(b.start_h + 1e-9));
      // 막대 끝까지 띠 안에 들게: 착수는 공정 시작일 0시간 ~ 공정 납기 끝 − 막대 길이. 막대가 띠 밖이면 지금 자리까지 넓힌다
      const lo = Math.min(abs(win ? win.start : 1, 0), now);
      const hi = Math.max(win ? abs(until, HOURS) - Math.ceil(len - 1e-9) : abs(ctx.scenario.days, HOURS - 1), now);
      const pinned = ctx.starts[id] !== undefined;
      const pinText = pinned ? dayHour(ctx.starts[id], ctx.startHours[id] ?? 0) : "";
      const waitedH = abs(b.start, b.start_h) - abs(b.ready, b.ready_h ?? 0);
      const ry = y + i * ROW_H;
      const work = `${num(b.std_mh)} MH · 2명 × ${num(len)}시간`;
      const row = s("g", {
        class: `block-row${b.risk ? " risk" : ""}${pinned ? " pinned" : ""}`, tabindex: 0, role: "listitem", "data-block": id, "data-own-keys": "",
        "aria-label": `${st.name} ${blockLabel(st.id, b.no)} ${dayHour(b.start, b.start_h)}~${dayHour(b.end, b.end_h)}, ${work}, ${b.unit}호 작업장, 납기 ${b.due}일`
          + `${waitedH > 0 ? `, 작업장 대기 ${num(waitedH)}시간` : ""}${pinned ? `, 착수 ${pinText}` : ""}${b.risk ? ", 계획상 위험" : ""}`,
      });
      const bar = s("g", { class: "block-drag" },
        s("rect", {
          x: x0, y: ry + (ROW_H - BAR_H) / 2, width: Math.max(1, x1 - x0), height: BAR_H, rx: 2,
          fill: STATION_COLOR[st.id], class: "block-bar",
        }, s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${dayHour(b.start, b.start_h)} ~ ${dayHour(b.end, b.end_h)} · ${work} · ${b.unit}호 작업장 · 납기 ${b.due}일${pinned ? ` · 착수 ${pinText}` : ""}`)));
      row.append(
        s("rect", { x: 0, y: ry, width: W, height: ROW_H, class: "plan-hit" }),
        s("text", { x: 14, y: ry + ROW_H - 3, class: "ship-id small" }, blockLabel(st.id, b.no)),
      );
      // 들어갈 수 있었는데 작업장이 차서 기다린 시간(다른 블록을 하는 중): 막대 앞 얇은 띠
      if (waitedH > 0) {
        // 대기는 얇은 띠(4.29.2 사용자: 블록 막대와 같은 굵기는 어색해 되돌림)
        row.append(s("rect", { x: at(b.ready, b.ready_h ?? 0), y: ry + ROW_H / 2 - 1.5, width: Math.max(1, x0 - at(b.ready, b.ready_h ?? 0)), height: 3, fill: WAIT.color, class: "block-wait" },
          s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${WAIT.name} ${num(waitedH)}시간(${dayHour(b.ready, b.ready_h ?? 0)} ~ ${dayHour(b.start, b.start_h)}): 작업장에서 다른 블록을 하는 중`)));
      }
      row.append(bar, s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: ry + 1, y2: ry + ROW_H - 1, class: "due block-due" }));
      if (b.risk) row.append(s("text", { x: Math.min(x1 + 2, W - RIGHT), y: ry + ROW_H - 3, class: "plan-late" }, "!"));
      svg.append(row);

      const moveTo = (hours: number) => {
        const next = Math.max(lo, Math.min(hi, hours));
        if (next === now && !pinned) return;
        focusedBlock = id;
        ctx.onMoveStart(id, Math.floor(next / HOURS) + 1, next % HOURS);
      };
      // 끌기: 좌우로만, 움직인 시간만큼(범위 안에서) 막대를 옮겨 보이고, 놓으면 그 시각을 착수일·착수 시각으로
      let fromX: number | null = null;
      let shift = 0;
      bar.addEventListener("pointerdown", (e) => {
        const ev = e as PointerEvent;
        fromX = ev.clientX;
        shift = 0;
        bar.setPointerCapture(ev.pointerId);
        row.classList.add("dragging");
      });
      bar.addEventListener("pointermove", (e) => {
        if (fromX === null) return;
        const scale = W / svg.getBoundingClientRect().width;
        const hours = Math.round((((e as PointerEvent).clientX - fromX) * scale) / hourW);
        shift = Math.max(lo, Math.min(hi, now + hours)) - now;
        bar.setAttribute("transform", `translate(${at(1, now + shift) - x0} 0)`);
      });
      const drop = () => {
        if (fromX === null) return;
        fromX = null;
        row.classList.remove("dragging");
        bar.removeAttribute("transform");
        if (shift) moveTo(now + shift);
      };
      bar.addEventListener("pointerup", drop);
      bar.addEventListener("pointercancel", drop);
      row.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        if (!ev.altKey || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
        ev.preventDefault();
        const base = pinned ? abs(ctx.starts[id], ctx.startHours[id] ?? 0) : now;
        moveTo(base + (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? HOURS : 1));
      });
    });
    y += ids.length * ROW_H;
  }

  if (focusedBlock) {
    const target = svg.querySelector<SVGGElement>(`[data-block="${focusedBlock}"]`);
    queueMicrotask(() => target?.focus());
  }
  return svg;
}
