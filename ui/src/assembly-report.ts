// 조립 공정 실적서(4.25, D71; 4.36.1 그림으로 다시 짬): 블록 조립 실습의 평가서 클립보드에 끼운 낱장.
// 사용자(4.36.1): "조립 실적서 전체적으로 가독성이 좋지 않아. 불필요한 내용은 줄이고, 그래프화하는 방식으로".
//   ① 한눈에: 인도 · 블록 납기 · 공수 효율 · 비상 예산 네 숫자
//   ② 배별 버퍼(프로젝트 버퍼 시나리오): 고른 버퍼 가운데 쓴 날과 넘친 날을 막대 하나로
//   ③ 공정별 계획 대비 지연: 배 × 공정 칸, 늦은 날만큼 진하게(한 색 진하기)
//   ④ 블록 공정 공수: 작업 · 재작업 · 대기(사람이 쉰 시간)를 쌓은 막대와 효율
//   ⑤ 블록이 기다린 이유: 자재 · 작업장 · 짝 · 인력 대기(블록·일)를 쌓은 막대
//   ⑥ 규칙 추천과 ⑦ 결정 돌아보기는 요약 한 줄, 자세한 표는 접는다
// 색은 labels.ts의 검증한 손실 색(재작업·자재·인력·작업장 대기)과 공정 색만 쓴다. 숫자는 막대 옆 글자로도 적어 색에만 기대지 않는다.
// 화면은 계산하지 않는다: 엔진 결과(block_due, manhours, block_eval, ships.station_dues, recommend)를 그림으로 옮긴다.

import type { DispatchRule, Result, Scenario } from "./api";
import { h, num, pct, s } from "./dom";
import { DISPATCH_INFO, LOSS_STATES, PAIR_WAIT_EDGE, PAIR_WAIT_STATE, STATION_COLOR } from "./labels";
import { recommendCard } from "./report";

const W = 640;
const LABEL_W = 92;
const VALUE_W = 120;
const loss = (state: string) => LOSS_STATES.find((x) => x.state === state)!.color;
const WORK_COLOR = "#3f6152";   // 4.36 버퍼 간트의 계획 작업과 같은 색
// 4.37.1 무게감(사용자 "버퍼를 넘는 것과 공정별 납기일을 넘는 것은 무게감이 달라"): 계획(공정·블록 납기)보다 늦어 버퍼를 먹음 = 황색 주의,
// 버퍼를 넘겨 인도가 늦음 = 진한 빨강 심각. 색각 이상에 대비해 채움(옅게 / 꽉)과 글자("먹음" / "지연")도 다르게
const WARN_FILL = "#f1d58a";
const WARN_EDGE = "#b8860b";
const LATE_FILL = "#b3261e";

export function renderAssemblyReport(result: Result, scenario: Scenario, onApplyRule?: (rule: DispatchRule) => void,
  review?: HTMLElement | null): HTMLElement | null {
  const bd = result.block_due;
  if (!bd || !result.blocks) return null;
  const name = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const blockSt = [...new Set(result.blocks.map((b) => b.station))];
  const sec = (title: string, note: string | null, ...body: (HTMLElement | SVGElement | null)[]) =>
    h("section", { class: "report-sec asm-sec" }, h("h3", null, title, note ? h("small", null, ` ${note}`) : null), ...body);
  return h("div", { class: "asm-report" },
    tiles(result, scenario),
    scenario.project_buffer ? sec("배별 버퍼", "고른 버퍼 가운데 쓴 날, 넘치면 인도 지연", bufferChart(result)) : null,
    sec("공정별 계획 대비 지연", "칸 = 그 배가 그 공정을 계획보다 며칠 늦게 마쳤나", delayGrid(result, scenario)),
    result.manhours ? sec("블록 공정 공수", "MH = 사람 × 시간. 효율 = 표준 ÷ 투입", manhourChart(result, blockSt, name)) : null,
    result.block_eval ? sec("블록이 기다린 이유", "블록·일 = 블록이 그 상태로 보낸 날의 합", waitChart(result, blockSt, name)) : null,
    recommendLine(result, onApplyRule),
    review ? h("section", { class: "report-sec asm-sec asm-review" }, h("h3", null, `결정 돌아보기`, h("small", null, ` 몰리는 날 ${result.review!.length}번`)), review) : null);
}

/** ① 한눈에: 네 숫자 */
function tiles(result: Result, scenario: Scenario): HTMLElement {
  const bd = result.block_due!;
  const late = result.ships.filter((sh) => sh.late_days > 0);
  const eff = result.manhours?.total.efficiency ?? null;
  const spent = result.block_eval?.all.emergency ?? 0;
  const acts = Object.values(result.block_eval?.all.actions ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  // 4.37.1: 무게감 구분. 인도 지연(버퍼 초과)은 빨강, 블록 납기(계획) 넘김은 황색
  const tile = (label: string, value: string, sub: string, sev: "" | "warn" | "bad" = "") =>
    h("div", { class: `asm-tile${sev ? ` ${sev}` : ""}` }, h("small", null, label), h("b", null, value), h("span", null, sub));
  return h("div", { class: "asm-tiles" },
    tile("인도 납기", `${result.ships.length - late.length} / ${result.ships.length}척`,
      late.length ? late.map((sh) => `${sh.id} ${sh.late_days}일 지연`).join(", ") : "모두 납기 내", late.length > 0 ? "bad" : ""),
    tile("블록 납기", `${bd.on_time} / ${bd.blocks}`, `준수율 ${bd.rate === null ? "—" : pct(bd.rate, 0)} · 늦은 날 합 ${bd.late_days}일`, bd.on_time < bd.blocks ? "warn" : ""),
    tile("공수 효율", eff === null ? "—" : pct(eff, 0), result.manhours ? `표준 ${num(result.manhours.total.standard, 0)} ÷ 투입 ${num(result.manhours.total.input, 0)} MH` : ""),
    scenario.decision_stations
      ? tile("비상 조치", acts ? `${acts}건` : "없음", spent ? `비상 예산 ${num(spent, 0)} 사용` : "비상 예산 쓰지 않음")
      : null);
}

/** ② 배별 버퍼: 고른 버퍼(빗금 칸) 가운데 쓴 날(진하게), 넘친 날(붉게, 인도 지연). 남는 날은 보관비로 냈다 */
function bufferChart(result: Result): HTMLElement {
  const rows = result.ships.map((sh) => {
    const buf = sh.buffer ?? 0;
    const done = sh.completed_day ?? sh.delivered_day ?? null;
    const used = done === null ? buf : Math.max(0, done - (sh.due_day - buf));
    return { id: sh.id, buf, used, over: Math.max(0, used - buf), done };
  });
  const maxDays = Math.max(1, ...rows.map((r) => Math.max(r.buf, r.used)));
  const rowH = 26, top = 6;
  const dayW = (W - LABEL_W - VALUE_W) / maxDays;
  const svg = s("svg", { class: "asm-chart", viewBox: `0 0 ${W} ${top + rows.length * rowH + 4}`, role: "img",
    "aria-label": "배별 버퍼: " + rows.map((r) => `${r.id} 버퍼 ${r.buf}일 중 ${Math.min(r.used, r.buf)}일 씀${r.over ? `, ${r.over}일 지연` : ""}`).join("; ") });
  svg.append(s("defs", null, s("pattern", { id: "asm-buf-hatch", width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
    s("rect", { width: 5, height: 5, fill: "#e4efe7" }), s("rect", { width: 1.4, height: 5, fill: "#8fb79c" }))));
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const x0 = LABEL_W;
    svg.append(s("text", { x: 0, y: y + 15, class: "asm-chart-label" }, r.id));
    if (r.buf) svg.append(s("rect", { x: x0, y: y + 4, width: r.buf * dayW, height: 14, rx: 3, fill: "url(#asm-buf-hatch)", class: "asm-buf-track" },
      s("title", null, `${r.id} 고른 버퍼 ${r.buf}일`)));
    const usedIn = Math.min(r.used, r.buf);
    if (usedIn) svg.append(s("rect", { x: x0, y: y + 4, width: usedIn * dayW - (r.over ? 1 : 0), height: 14, rx: 3, fill: WARN_FILL, stroke: WARN_EDGE, "stroke-width": 0.8 },
      s("title", null, `${r.id} 버퍼 ${usedIn}일 씀`)));
    if (r.over) svg.append(s("rect", { x: x0 + r.buf * dayW + 1, y: y + 4, width: r.over * dayW - 1, height: 14, rx: 3, fill: LATE_FILL },
      s("title", null, `${r.id} 버퍼를 ${r.over}일 넘겨 인도 지연`)));
    const text = r.done === null ? "못 마침"
      : r.over ? `버퍼 ${r.buf}일 넘겨 ${r.over}일 지연` : `${r.buf}일 중 ${usedIn}일 씀 · ${r.buf - usedIn}일 남음`;
    svg.append(s("text", { x: W, y: y + 15, class: `asm-chart-value${r.over ? " bad" : ""}` }, text));
  });
  return wrap(svg, legend([["#e4efe7", "고른 버퍼", "#8fb79c"], [WARN_FILL, "쓴 날(주의)", WARN_EDGE], [LATE_FILL, "넘친 날(인도 지연)"]]),
    "황색은 계획보다 늦어 버퍼를 먹은 날(주의), 빨강은 버퍼를 넘겨 인도가 늦은 날(심각)입니다. 남은 날만큼 배가 일찍 끝나 납기일까지 보관비를 냈습니다.");
}

/** ③ 공정별 계획 대비 지연: 배 × 공정 칸. 0일은 비우고, 늦은 날만큼 한 색(재작업 색)으로 진하게, 숫자를 칸 안에 */
function delayGrid(result: Result, scenario: Scenario): HTMLElement {
  const stations = scenario.stations.filter((st) => !scenario.skip?.includes(st.id));
  const blockSt = new Set(result.blocks!.map((b) => b.station));
  const shade = (d: number) => (d <= 0 ? "" : d === 1 ? "d1" : d === 2 ? "d2" : d <= 4 ? "d3" : "d4");
  return h("div", { class: "asm-grid-wrap" },
    h("table", { class: "asm-grid" },
      h("thead", null, h("tr", null, h("th", null, ""), stations.map((st) => h("th", { class: blockSt.has(st.id) ? "blk" : "" },
        blockSt.has(st.id) ? h("i", { class: "swatch", style: { background: STATION_COLOR[st.id] } }) : null, st.name)))),
      h("tbody", null, result.ships.map((sh) => h("tr", null, h("th", null, sh.id),
        stations.map((st) => {
          const d = sh.station_dues?.[st.id];
          if (!d) return h("td", null, "");
          if (d.end === null) return h("td", { class: "d4", title: `${sh.id} ${st.name} 못 마침(공정 납기 ${d.due}일)` }, "못 마침");
          return h("td", { class: shade(d.late_days), title: `${sh.id} ${st.name} ${d.end}일에 마침 · 공정 납기 ${d.due}일` },
            d.late_days ? `+${d.late_days}` : "");
        }))))),
    h("div", { class: "legend asm-legend" }, h("span", null, h("i", { class: "asm-shade-0" }), "계획대로"),
      ["d1", "d2", "d3", "d4"].map((c, k) => h("span", null, h("i", { class: `asm-shade-${c}` }), ["+1일", "+2일", "+3~4일", "+5일 이상"][k]))),
    h("p", { class: "hint" }, scenario.project_buffer
      ? "공정 납기는 계획(변수 없이 돌린 실행)에서 끝나는 날이라, 황색 칸은 계획보다 늦어 버퍼를 먹은 곳(주의)입니다. 버퍼를 넘겨 인도가 늦었는지는 위 배별 버퍼(빨강)로 봅니다. 왼쪽에서 처음 진해지는 칸이 늦기 시작한 곳입니다."
      : "왼쪽에서 처음 진해지는 칸이 늦기 시작한 곳입니다. 칸에 마우스를 올리면 마친 날과 공정 납기가 보입니다."));
}

/** ④ 블록 공정 공수: 작업 · 재작업 · 대기를 쌓은 가로 막대(합 = 투입), 오른쪽에 효율 */
function manhourChart(result: Result, blockSt: string[], name: Record<string, string>): HTMLElement {
  const mh = result.manhours!;
  const rows = blockSt.filter((sid) => mh.stations[sid]).map((sid) => ({ sid, r: mh.stations[sid] }));
  const max = Math.max(1, ...rows.map(({ r }) => r.input));
  const rowH = 26, top = 6;
  const scale = (W - LABEL_W - VALUE_W) / max;
  const parts: [keyof typeof rows[number]["r"], string, string][] = [["work", WORK_COLOR, "작업"], ["rework", loss("rework"), "재작업"], ["idle", "#c9c5bb", "대기(쉰 시간)"]];
  const svg = s("svg", { class: "asm-chart", viewBox: `0 0 ${W} ${top + rows.length * rowH + 4}`, role: "img",
    "aria-label": "블록 공정 공수: " + rows.map(({ sid, r }) => `${name[sid]} 투입 ${num(r.input, 0)} MH, 효율 ${r.efficiency === null ? "—" : pct(r.efficiency, 0)}`).join("; ") });
  rows.forEach(({ sid, r }, i) => {
    const y = top + i * rowH;
    svg.append(s("rect", { x: 0, y: y + 6, width: 8, height: 10, rx: 2, fill: STATION_COLOR[sid] }),
      s("text", { x: 12, y: y + 15, class: "asm-chart-label" }, name[sid]));
    let x = LABEL_W;
    for (const [key, color, label] of parts) {
      const v = r[key] as number;
      if (v <= 0) continue;
      const w = v * scale;
      svg.append(s("rect", { x, y: y + 4, width: Math.max(1, w - 2), height: 14, rx: 2, fill: color },
        s("title", null, `${name[sid]} ${label} ${num(v, 1)} MH`)));
      x += w;
    }
    svg.append(s("text", { x: W, y: y + 15, class: "asm-chart-value" },
      `투입 ${num(r.input, 0)} MH · 효율 ${r.efficiency === null ? "—" : pct(r.efficiency, 0)}`));
  });
  return wrap(svg, legend(parts.map(([, c, l]) => [c, l] as [string, string])),
    "막대 길이가 투입 공수(작업장에 보낸 사람 × 근무시간)입니다. 재작업과 대기(블록을 끝냈는데 들어올 블록이 없어 쉰 시간)가 길수록 효율이 떨어집니다.");
}

/** ⑤ 블록이 기다린 이유: 공정마다 자재 · 작업장 · 짝 · 인력 대기(블록·일)를 쌓은 막대, 오른쪽에 늦은 블록 */
function waitChart(result: Result, blockSt: string[], name: Record<string, string>): HTMLElement {
  const ev = result.block_eval!;
  const causes: [string, string, string, string?][] = [
    ["material_wait", loss("material_wait"), "자재"], ["station_wait", loss("station_wait"), "작업장"],
    ["pair_wait", PAIR_WAIT_STATE.color, "짝", PAIR_WAIT_EDGE], ["labor_wait", loss("labor_wait"), "인력"]];
  const rows = blockSt.filter((sid) => ev.stations[sid]).map((sid) => ({ sid, r: ev.stations[sid] }));
  const total = (r: typeof rows[number]["r"]) => causes.reduce((a, [k]) => a + (r.waits[k] ?? 0), 0);
  const max = Math.max(1, ...rows.map(({ r }) => total(r)));
  const rowH = 26, top = 6;
  const scale = (W - LABEL_W - VALUE_W) / max;
  const svg = s("svg", { class: "asm-chart", viewBox: `0 0 ${W} ${top + rows.length * rowH + 4}`, role: "img",
    "aria-label": "블록이 기다린 이유: " + rows.map(({ sid, r }) => `${name[sid]} ` + causes.map(([k, , l]) => `${l} ${r.waits[k] ?? 0}`).join(", ")).join("; ") });
  rows.forEach(({ sid, r }, i) => {
    const y = top + i * rowH;
    svg.append(s("rect", { x: 0, y: y + 6, width: 8, height: 10, rx: 2, fill: STATION_COLOR[sid] }),
      s("text", { x: 12, y: y + 15, class: "asm-chart-label" }, name[sid]));
    let x = LABEL_W;
    for (const [key, color, label, edge] of causes) {
      const v = r.waits[key] ?? 0;
      if (!v) continue;
      const w = v * scale;
      svg.append(s("rect", { x, y: y + 4, width: Math.max(1, w - 2), height: 14, rx: 2, fill: color, ...(edge ? { stroke: edge, "stroke-width": 0.8 } : {}) },
        s("title", null, `${name[sid]} ${label} 대기 ${v}블록·일`)));
      if (w > 22) svg.append(s("text", { x: x + (w - 2) / 2, y: y + 14.5, class: `asm-bar-num${edge ? " dark" : ""}` }, String(v)));
      x += w;
    }
    svg.append(s("text", { x: W, y: y + 15, class: `asm-chart-value${r.late_blocks ? " bad" : ""}` },
      r.late_blocks ? `늦은 블록 ${r.late_blocks}개 · ${r.late_days}일` : "늦은 블록 없음"));
  });
  return wrap(svg, legend(causes.map(([, c, l, e]) => [c, `${l} 대기`, e] as [string, string, string?])),
    "작업장 대기가 길면 일감이 몰린 곳, 짝 대기가 길면 짝 블록 순서가 어긋난 곳, 자재 대기는 입고·운반을 봅니다.");
}

/** ⑥ 규칙 추천: 한 줄 + 단추, 규칙별 비교 표는 접어 둔다 */
function recommendLine(result: Result, onApplyRule?: (rule: DispatchRule) => void): HTMLElement | null {
  const rc = result.recommend;
  if (!rc) return null;
  const best = rc.rules.find((r) => r.rule === rc.best)!;
  return h("section", { class: "report-sec asm-sec" },
    h("h3", null, "블록 우선순위 규칙"),
    h("p", { class: "asm-line" }, rc.current_is_best
      ? "지금 계획이 네 규칙보다 못하지 않습니다."
      : [`${DISPATCH_INFO[rc.best].name}이면 인도 ${best.on_time}척 · 이익 ${num(best.profit, 0)}`,
        ` (지금 ${rc.current.on_time}척 · ${num(rc.current.profit, 0)})`].join(""),
    !rc.current_is_best && onApplyRule
      ? h("button", { type: "button", class: "btn small", onclick: () => onApplyRule(rc.best) }, `추천대로 다시 계획`) : null),
    h("details", { class: "asm-more" }, h("summary", null, "규칙별 비교 표"), recommendCard(result)));
}

function wrap(svg: SVGElement, legendEl: HTMLElement, note: string): HTMLElement {
  return h("div", { class: "asm-chart-wrap" }, svg, legendEl, h("p", { class: "hint" }, note));
}

function legend(items: [string, string, string?][]): HTMLElement {
  return h("div", { class: "legend asm-legend" }, items.map(([c, l, edge]) =>
    h("span", null, h("i", { style: { background: c, ...(edge ? { outline: `1px solid ${edge}` } : {}) } }), l)));
}
