// 한 번의 실행 레포트: 등급, 의문점 카드, QCD, 현황, 원가 내역, 리드타임 분해, 공정별 OEE, 재고 금액 추이, 사건 기록.
// 뒷장 메모(4.23): 부록 7관리 지표와 선배의 팁.
// 모든 숫자는 엔진 결과에 있는 값이다. 막대 길이와 차트 좌표를 정하는 비율만 화면에서 구한다.

import type { DispatchMetrics, DispatchRule, Finding, Grade, Management, MgmtPoint, Result, Scenario, ShipResult, SimEvent } from "./api";
import { h, money, num, pct, s, signed } from "./dom";
import { openOptions } from "./form";
import { AUTHOR } from "./paper";
import { COST_ITEMS, DISPATCH_INFO, EVENT_NAME, GRADE_COLOR, GRADE_NOTE, GRADE_TEXT, LEAD_TIME_STATES, STATE_INFO, STATION_COLOR } from "./labels";

export function eventText(ev: SimEvent, scenario: Scenario): string {
  const station = (id: string) => scenario.stations.find((st) => st.id === id)?.name ?? id;
  // 고장 나는 것은 공정의 설비다(4.12.1): "PE장 크롤러 크레인"
  const equipment = (id: string) => {
    const eq = scenario.stations.find((st) => st.id === id)?.equipment;
    return typeof eq === "string" ? `${station(id)} ${eq}` : `${station(id)} 설비`;
  };
  const material = (id: string) => scenario.materials.find((m) => m.id === id)?.name ?? id;
  switch (ev.type) {
    case "arrival": return `${material(ev.material)} ${ev.quantity}개 입고 (${ev.safety ? "안전 재고" : `${ev.ship}용`})`;
    case "supply_delay": return `${material(ev.material)} ${ev.quantity}개 (${ev.ship}용) 입고 ${ev.days}일 지연 → ${ev.arrival_day}일 입고`;
    case "issue": return `${material(ev.material)} ${ev.quantity}개 출고 → ${ev.ship} ${station(ev.station)}${ev.forklift ? ` (지게차 ${ev.forklift} 자재 키트)` : ev.transporter ? ` (${ev.transporter} 자재 키트)` : ""}`;
    case "enter": return `${ev.ship} ${station(ev.station)} 투입${ev.units ? ` (${ev.units.join("·")}호에 나눠)` : ""}`;
    case "complete": return `${ev.ship} ${station(ev.station)} 완료`;
    case "defect": return `${ev.ship} ${station(ev.station)} 검사 불량 → 재작업`;
    case "accident": return `${station(ev.station)} 잔업 사고 → 3일 중지`;
    case "breakdown": return ev.forklift
      ? `지게차 ${ev.forklift} 고장 → 2일 중지`
      : ev.transporter
      ? `트랜스포터 고장 → 2일 중지`
      : `${equipment(ev.station ?? "")} 고장 → 2일 중지`;
    case "transport_start": return `${ev.ship} ${station(ev.from)} → ${station(ev.to)} 운반 시작`;
    case "transport_end": return `${ev.ship} ${station(ev.to)}에 도착`;
    case "research_done": {
      const info = scenario.research[ev.research];
      return `${info?.name ?? ev.research} 완료, 내일부터: ${info?.effect ?? "효과"}`;
    }
    case "delivery": return ev.late_days > 0 ? `${ev.ship} 인도, ${ev.late_days}일 지연` : `${ev.ship} 인도, 납기 준수`;
  }
}

function eventTone(ev: SimEvent): string {
  if (ev.type === "defect" || ev.type === "accident" || ev.type === "breakdown" || ev.type === "supply_delay") return "bad";
  if (ev.type === "delivery") return ev.late_days > 0 ? "bad" : "good";
  if (ev.type === "research_done") return "good";
  return "";
}

/** 리드타임 분해 막대 하나. scale은 막대 전체 폭에 해당하는 일수. */
export function breakdownBar(ship: ShipResult, scale: number): HTMLElement {
  return h("div", { class: "stack", title: `${ship.id} 리드타임 ${ship.lead_time}일` },
    LEAD_TIME_STATES.map((b) => {
      const days = ship.lead_time_parts[b.state] ?? 0;
      if (!days) return null;
      return h("span", {
        class: `stack-part${b.hatch ? " hatch" : ""}${b.state === "transport" ? " light" : ""}`,
        style: { width: `${(days / scale) * 100}%`, background: b.color },
        title: `${b.name} ${days}일`,
      }, days >= 2 ? String(days) : "");
    }));
}

export function breakdownLegend(): HTMLElement {
  // 작업·운반(손실 아님) 다음에 줄을 바꿔 손실 칸을 둘째 줄에(4.12.4)
  const item = (b: (typeof LEAD_TIME_STATES)[number]) =>
    h("span", null, h("i", { class: b.hatch ? "hatch-over" : "", style: { background: b.color } }), b.name);
  return h("div", { class: "legend" },
    LEAD_TIME_STATES.slice(0, 2).map(item), h("span", { class: "break" }), LEAD_TIME_STATES.slice(2).map(item));
}

function card(title: string, ...body: (HTMLElement | SVGElement | null)[]): HTMLElement {
  return h("div", { class: "card" }, h("h3", null, title), ...body);
}

// 평가서의 QCD 칸 접기(4.14). 열림 상태는 회차를 바꿔도 그대로 둔다. 위의 등급·의문점·QCD 요약은 접지 않는다.
const REPORT_FOLD_DEFAULT: Record<string, boolean> = { q: true, c: true, d: true, s: true, events: false, mgmt: true };
const reportFolds = new Map<string, boolean>();

/** QCD 칸: 제목 줄(Q·C·D 표, 이름, 접었을 때 보일 요약)과 카드 묶음 */
function qcdSection(key: string, tag: string | null, title: string, summary: string, ...cards: (HTMLElement | null)[]): HTMLElement {
  const box = h("details", { class: `fold report-sec`, open: reportFolds.get(key) ?? REPORT_FOLD_DEFAULT[key] ?? true },
    h("summary", null,
      tag ? h("span", { class: `kpi-tag sec-tag ${tag.toLowerCase()}` }, tag) : null,
      h("b", { class: "fold-title" }, title),
      h("span", { class: "fold-sum" }, summary)),
    h("div", { class: "report-grid" }, ...cards));
  box.addEventListener("toggle", () => { reportFolds.set(key, (box as HTMLDetailsElement).open); });
  return box;
}

// 의문점 카드의 "어디를 볼까". 손실 종류마다 정해진 안내 문구다.
const FINDING_HINT: Record<string, string> = {
  rework: "검사 불량. 공법, 잔업, 정비, 시니어 배치를 확인하세요.",
  material_wait: "자재가 아직 안 들어왔습니다. 발주일 + 리드타임을 확인하세요.",
  labor_wait: "대기소에 보낼 사람이 없었습니다. 인원이나 우선순위를 확인하세요.",
  station_wait: "앞 배가 작업장을 쓰고 있었습니다. 착수 예정일 간격을 확인하세요.",
  transport_wait: "트랜스포터가 다른 로트를 나르거나 고장이었습니다.",
  accident_stop: "잔업 사고로 작업장이 멈췄습니다.",
  breakdown_stop: "설비 고장으로 멈췄습니다. 정비 여부를 확인하세요.",
};

function findingText(f: Finding, scenario: Scenario): string {
  const station = scenario.stations.find((st) => st.id === f.station)?.name ?? f.station;
  const name = STATE_INFO[f.kind]?.name ?? f.kind;
  const where = f.kind === "transport_wait" ? `${station} 완료 후` : station;
  return `${f.ship} · ${where} · ${name} ${f.days}일 (${f.start}~${f.end}일)`;
}

// 부록: 7관리 지표와 개선 포인트(4.15, D61). 지표와 포인트는 엔진이 고르고, 화면은 포인트 종류마다 정한 안내만 붙인다.
// 안내는 생산계획서 칸 번호(① 사람 ② 공용 설비 ③ 자재 ④ 공정 ⑤ 연구, 4.14)로 고칠 곳을 가리키고, 분기에서 열린 선택지만 말한다.
const MGMT_ROWS: { key: keyof Management; name: string }[] = [
  { key: "plan", name: "계획" }, { key: "schedule", name: "일정" }, { key: "material", name: "자재" },
  { key: "equipment", name: "설비" }, { key: "quality", name: "품질" }, { key: "safety", name: "안전" },
];

function pointText(point: MgmtPoint, scenario: Scenario): string {
  const opts = openOptions(scenario);
  const station = (id: string | null) => (id ? scenario.stations.find((st) => st.id === id)?.name ?? id : "");
  const list = (xs: (string | false | undefined)[]) => xs.filter(Boolean).join(", ");
  const predictive = scenario.research.predictive?.name;
  const inspect = scenario.research.auto_inspect?.name;
  switch (point.code) {
    case "conflict":
      return `계획 간트에서 같은 작업장을 겹쳐 쓴 날이 ${point.days}일입니다. 겹친 만큼 뒤 순위 배가 기다립니다. `
        + `착수 예정일 간격을 벌리${opts.max_units > 1 ? "거나 ④ 공정에서 작업장을 늘리" : ""}세요.`;
    case "slip":
      return `${point.ship}이 계획 간트의 끝날보다 ${point.days}일 늦게 인도됐습니다. 겹침이 없어도 대기·불량·고장이 계획을 밀어냅니다. 아래 요소를 확인하세요.`
        + (opts.plan_buffer ? ` 밀릴 것을 알면 ④ 공정의 여유로 납기에 넣을 수 있지만, 여유 하루에 선가가 ${num(scenario.plan_buffer.price_cut_per_day * 100, 0)}% 깎입니다.` : "");
    case "station_wait":
      return `${station(point.station)} 작업장을 기다린 날이 가장 많습니다(${point.days}일). 병목 공정입니다. `
        + `착수 예정일 간격, ④ 공정의 ${list([opts.max_units > 1 && "작업장 수", "잔업", opts.methods.length > 1 && "공법"])}을 확인하세요.`;
    case "labor_wait":
      return `${station(point.station)}에 보낼 사람이 없어 기다린 날이 가장 많습니다(${point.days}일). ① 사람에서 그 직종 인원을 확인하세요.`;
    case "transport_wait":
      return `${station(point.station)}을 끝낸 블록이 트랜스포터를 기다린 날이 가장 많습니다(${point.days}일). `
        + `② 공용 설비에서 트랜스포터 ${(opts.transporter_counts?.length ?? 1) > 1 ? "대수와 " : ""}정비를 확인하세요.`;
    case "material_wait":
      return `자재를 기다린 날이 ${point.days}일이고 ${station(point.station)}에서 가장 길었습니다. `
        + `③ 자재에서 ${list(["발주 방식", opts.jit_buffer && "역산 여유일", opts.safety_stock && "안전 재고"])}을 확인하세요.`;
    case "holding":
      return `자재 대기는 없지만 일괄 발주로 재고비 ${money(point.cost)}를 냈습니다. ③ 자재에서 역산 발주로 바꿔 보세요.`;
    case "breakdown":
      return `${station(point.station)} 설비 고장으로 ${point.days}일 멈췄습니다. ④ 공정의 정비${predictive ? `, ⑤ 연구의 ${predictive}` : ""}를 확인하세요.`;
    case "defect":
      return `${station(point.station)}에서 불량이 가장 많습니다(${point.count}건). `
        + `④ 공정의 ${list([opts.methods.length > 1 && "공법", opts.crews.includes("skilled") && "숙련공", "정비", "잔업"])}`
        + `${opts.material_grades.includes("cheap") ? ", ③ 자재 등급" : ""}${inspect ? `, ⑤ 연구의 ${inspect}` : ""}을 확인하세요.`;
    case "accident":
      return `${station(point.station)}에서 잔업 사고가 가장 많습니다(${point.count}건). 잔업한 작업장에서 사고가 납니다. 잔업 대신 ${opts.max_units > 1 ? "① 사람의 인원이나 ④ 공정의 작업장 수" : "① 사람의 인원"}로 속도를 내 보세요.`;
    case "overtime":
      return `사고는 없었지만 ${station(point.station)}에서 ${point.days}일 잔업했습니다. 잔업한 날마다 사고 위험이 있습니다.`;
  }
}

function mgmtCard(m: Management, scenario: Scenario, safetyWarnings?: number): HTMLElement {
  const w = m.schedule.wait_days;
  const cells: Record<keyof Management, [string, string, string]> = {
    plan: ["계획대로 인도", `${m.plan.on_plan} / ${m.plan.ships}척`,
      `계획보다 밀린 날 ${m.plan.slip_days}일 · 계획 겹침 ${m.plan.conflict_days}일`],
    schedule: ["흐름 효율", pct(m.schedule.flow_efficiency, 0),
      `리드타임 ${m.schedule.lead_days}일 중 작업장 대기 ${w.station_wait} · 인력 대기 ${w.labor_wait} · 운반 대기 ${w.transport_wait}일`],
    material: ["자재 대기", `${m.material.wait_days}일`,
      `${scenario.supply_delays ? `입고 지연 ${m.material.supply_delays}건 · ` : ""}평균 재고 ${money(m.material.avg_inventory)} · 재고비 ${money(m.material.holding)}`],
    equipment: ["평균 OEE", pct(m.equipment.oee, 0),
      `고장 ${m.equipment.breakdowns}건 · 고장으로 멈춘 날 ${m.equipment.stop_days}일`],
    quality: ["직행률", pct(m.quality.first_pass_yield, 0),
      `불량 ${m.quality.defects}건 · 재작업 ${m.quality.rework_days}일`],
    safety: ["잔업 사고", `${m.safety.accidents}건`,
      `사고로 멈춘 날 ${m.safety.stop_days}일 · 잔업 ${m.safety.overtime_days}일${safetyWarnings === undefined ? "" : ` · 현장 안전 경고 ${safetyWarnings}회`}`],
  };
  return card("7관리 지표와 개선 포인트",
    h("div", { class: "mgmt" },
      h("div", { class: "mgmt-row mgmt-head" }, h("span", null, "요소"), h("span", null, "지표"), h("span", null, "개선 포인트")),
      MGMT_ROWS.map(({ key, name }) => {
        const [label, value, sub] = cells[key];
        const point = m[key].point;
        return h("div", { class: "mgmt-row" },
          h("b", { class: "mgmt-name" }, name),
          h("div", { class: "mgmt-value" },
            h("span", null, label, " ", h("b", null, value)),
            h("small", null, sub)),
          point
            ? h("p", { class: "mgmt-point" }, pointText(point, scenario))
            : h("p", { class: "mgmt-point good" }, "손실 없음"));
      })),
    h("p", { class: "hint" }, "교육의 7요소 중 데이터 관리는 이 평가서 전체(간트, 의문점, 사건 기록)가 맡아 따로 재지 않습니다. 7관리 지표는 등급 점수에 넣지 않습니다."));
}

function gradeCard(grade: Grade): HTMLElement {
  const base = grade.baseline;
  const vs = grade.vs_baseline;
  return h("div", { class: "grade-card" },
    h("div", { class: `grade-letter grade-${grade.grade}`, style: { background: GRADE_COLOR[grade.grade] ?? "#4b5a51", color: GRADE_TEXT[grade.grade] } },
      h("b", null, grade.grade), h("span", null, `${grade.score.toFixed(1)}점`),
      GRADE_NOTE[grade.grade] ? h("em", null, GRADE_NOTE[grade.grade]) : null),
    h("div", { class: "grade-body" },
      h("div", { class: "grade-parts" }, grade.parts.map((p) =>
        h("div", { class: "grade-part", title: `목표 ${p.key === "delivery" || p.key === "quality" ? pct(p.target, 0) : num(p.target)}` },
          h("span", { class: "gp-name" }, p.name),
          h("span", { class: "gp-bar" }, h("i", { style: { width: `${(p.points / p.max) * 100}%` } })),
          h("span", { class: "gp-value" }, `${num(p.points, 1)} / ${num(p.max)}`)))),
      base && vs
        ? h("p", { class: "baseline-line" },
          `${base.name}(${base.score.toFixed(1)}점 ${base.grade}) 대비 `,
          h("b", { class: vs.profit >= 0 ? "good" : "bad" }, `이익 ${signed(vs.profit, (v) => num(v, 1))}`), ", ",
          h("b", null, `인원 ${signed(vs.pool)}명`), ", ",
          h("b", { class: vs.score >= 0 ? "good" : "bad" }, `점수 ${signed(vs.score, (v) => v.toFixed(1))}`))
        : h("p", { class: "hint" }, "기준선과 비교할 수 없는 시나리오입니다."),
      h("p", { class: "hint" }, "점수 = 매출 30 + 이익 40(최대 52) + 납기 20 + 직행률 10 · S 100, A 85, B 70, C 50")));
}

/** 재고 금액 추이. 한 계열이라 범례 없이 제목이 이름이다. 날마다 마우스를 올리면 금액이 나온다. */
function inventoryChart(values: number[]): SVGElement {
  const W = 900, H = 170, L = 44, R = 10, T = 12, B = 22;
  const max = Math.max(1, ...values);
  const dx = (W - L - R) / Math.max(1, values.length - 1);
  const px = (i: number) => L + i * dx;
  const py = (v: number) => T + (1 - v / max) * (H - T - B);
  const line = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const area = `${line} L${px(values.length - 1).toFixed(1)} ${py(0)} L${px(0)} ${py(0)} Z`;
  const svg = s("svg", { class: "inv-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "날짜별 창고 재고 금액" },
    s("line", { x1: L, x2: W - R, y1: py(0), y2: py(0), class: "axis-line" }),
    s("line", { x1: L, x2: W - R, y1: py(max), y2: py(max), class: "grid" }),
    s("text", { x: L - 6, y: py(max) + 4, class: "tick end" }, num(max)),
    s("text", { x: L - 6, y: py(0) + 4, class: "tick end" }, "0"),
    s("path", { d: area, class: "inv-area" }),
    s("path", { d: line, class: "inv-line" }));
  const step = values.length > 60 ? 20 : 10;
  for (const d of [1, ...Array.from({ length: Math.floor(values.length / step) }, (_, k) => (k + 1) * step)]) {
    if (d <= values.length) svg.append(s("text", { x: px(d - 1), y: H - 6, class: "tick" }, `${d}일`));
  }
  // 마우스를 올릴 자리: 점보다 넓은 세로 띠
  values.forEach((v, i) => svg.append(
    s("rect", { x: px(i) - dx / 2, y: T, width: dx, height: H - T - B, class: "hit" },
      s("title", null, `${i + 1}일 재고 ${money(v)}`))));
  return svg;
}

export function renderReport(result: Result, scenario: Scenario, maxRate: number,
  onFinding: (f: Finding, where: "field" | "gantt") => void, safetyWarnings?: number): HTMLElement {
  const { qcd, status } = result;
  // S 안전(4.14, QCDS). 옛 회차 결과에는 없을 수 있어 status에서 채운다
  const safety = qcd.safety ?? { accidents: status.accidents, stop_days: 0, overtime_days: 0, accident_cost: result.costs.accident ?? 0 };
  const profitTone = result.profit >= 0 ? "good" : "bad";

  // 엔진이 손실 기간이 긴 순서로 준다(같으면 이른 것부터). 핵심 3개만 보여 준다.
  const findings = result.findings.slice(0, 3);
  const findingRow = h("div", { class: "findings" },
    h("h3", null, "의문점 Top 3 ", h("small", null, `손실 기간이 긴 순 · 전체 ${result.findings.length}건`)),
    findings.length
      ? findings.map((f, i) => h("div", { class: "finding", style: { borderLeftColor: STATE_INFO[f.kind]?.color } },
        h("b", null, h("span", { class: "rank" }, `${i + 1}`), findingText(f, scenario)),
        h("p", { class: "hint" }, FINDING_HINT[f.kind] ?? ""),
        h("div", { class: "finding-btns" },
          h("button", { type: "button", class: "btn primary small", onclick: () => onFinding(f, "field") }, `작업 현황에서 ${f.start}일 보기`),
          h("button", { type: "button", class: "btn ghost small", onclick: () => onFinding(f, "gantt") }, "간트"))))
      : h("p", { class: "hint" }, "손실 구간이 없습니다."));

  const qcdRow = h("div", { class: "qcd" },
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag q" }, "Q 직행률"),
      h("b", { class: "kpi-value" }, pct(qcd.quality.first_pass_yield)),
      h("span", { class: "kpi-sub" }, `품질 · 첫 검사 합격 ${qcd.quality.passes} / ${qcd.quality.inspections}`)),
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag c" }, "C 이익"),
      h("b", { class: `kpi-value ${profitTone}` }, money(result.profit)),
      h("span", { class: "kpi-sub" }, `원가 · 매출 ${money(result.revenue)} − 총원가 ${money(result.total_cost)}`)),
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag d" }, "D 납기 준수"),
      h("b", { class: `kpi-value ${qcd.delivery.on_time === qcd.delivery.ships ? "good" : "bad"}` },
        `${qcd.delivery.on_time} / ${qcd.delivery.ships}척`),
      h("span", { class: "kpi-sub" }, `납기 · 준수율 ${pct(qcd.delivery.on_time_rate, 0)} · 총 지연 ${qcd.delivery.total_late_days}일`)),
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag s" }, "S 안전사고"),
      h("b", { class: `kpi-value ${safety.accidents ? "bad" : "good"}` }, `${safety.accidents}건`),
      h("span", { class: "kpi-sub" }, `안전 · 사고로 멈춘 날 ${safety.stop_days}일 · 잔업 ${safety.overtime_days}일`)),
  );

  const wf = result.workforce;
  // Q: 품질과 설비(불량·고장)
  const qualityCard = card("품질과 설비",
    h("dl", { class: "status two" },
      h("div", null, h("dt", null, "불량"), h("dd", { class: status.defects ? "bad" : "" }, `${status.defects}건`)),
      h("div", null, h("dt", null, "설비 고장"), h("dd", { class: status.breakdowns ? "bad" : "" }, `${status.breakdowns}건`))),
    h("p", { class: "hint" }, `직행률 ${pct(qcd.quality.first_pass_yield)} = 첫 검사 합격 ${qcd.quality.passes} / 검사 ${qcd.quality.inspections}. 불량은 재작업으로 납기(D)와 원가(C)도 깎습니다. 고장은 정비로 줄입니다.`));
  // S: 안전(잔업 사고와 현장 안전 경고)
  const accidentList = result.events.filter((ev): ev is Extract<SimEvent, { type: "accident" }> => ev.type === "accident");
  const stationName = (id: string) => scenario.stations.find((st) => st.id === id)?.name ?? id;
  const safetyCard = card("안전",
    h("dl", { class: "status four" },
      h("div", null, h("dt", null, "잔업 사고"), h("dd", { class: safety.accidents ? "bad" : "" }, `${safety.accidents}건`)),
      h("div", null, h("dt", null, "사고로 멈춘 날"), h("dd", { class: safety.stop_days ? "bad" : "" }, `${safety.stop_days}일`)),
      h("div", null, h("dt", null, "잔업한 날"), h("dd", null, `${safety.overtime_days}일`)),
      h("div", null, h("dt", null, "현장 안전 경고"), h("dd", { class: safetyWarnings ? "bad" : "" }, safetyWarnings === undefined ? "—" : `${safetyWarnings}회`))),
    accidentList.length
      ? h("p", { class: "accident-list" }, "사고: ", accidentList.map((ev) => `${ev.day}일 ${stationName(ev.station)}(${ev.ship})`).join(" · "))
      : null,
    h("p", { class: "hint" }, `사고는 잔업한 작업장에서 납니다(잔업한 날이 사고 위험에 노출된 날). 사고 한 건에 작업장 3일 중지와 비용 300(합계 ${money(safety.accident_cost)}). `,
      "현장 안전 경고는 현장에서 위험 설비 반경에 들어간 횟수입니다. 안전은 등급 점수에 넣지 않습니다."));
  // C: 사람을 얼마나 놀렸나(인건비는 고정비라 쉰 인일이 곧 손실)
  const laborCard = card("인력 가동",
    h("div", { class: "util" },
      h("span", null, "작업자 가동률"),
      h("span", { class: "meter wide" }, h("i", { style: { width: `${wf.utilization * 100}%` } })),
      h("b", null, pct(wf.utilization)),
      h("small", null, `배정 ${wf.man_days}인일 ÷ (${wf.pool}명 × ${result.days}일) · 쉰 인일 ${wf.idle_man_days}`)),
    h("p", { class: "hint" }, "인건비는 일하지 않아도 나가는 고정비입니다. 쉰 인일이 많으면 인원을 줄여도 됩니다."));
  const maxCost = Math.max(1, ...COST_ITEMS.map((c) => result.costs[c.key] ?? 0));
  const costCard = card("원가 내역",
    h("div", { class: "cost-list" }, COST_ITEMS.map((item) => {
      const value = result.costs[item.key] ?? 0;
      return h("div", { class: "cost-row", title: item.note },
        h("span", { class: "cost-name" }, item.name),
        h("span", { class: "cost-bar" }, h("i", { style: { width: `${(value / maxCost) * 100}%` } })),
        h("span", { class: "cost-value" }, money(value)));
    })),
    h("div", { class: "cost-total" },
      h("span", null, "총원가"), h("b", null, money(result.total_cost)),
      h("span", null, "매출"), h("b", null, money(result.revenue)),
      h("span", null, "이익"), h("b", { class: profitTone }, money(result.profit))),
  );

  const scale = Math.max(1, ...result.ships.map((sh) => sh.lead_time));
  // D: 배마다 한 줄에 리드타임 분해와 착수·인도·납기·지연(4.14에 배별 표와 합쳤다)
  const leadCard = card("배별 납기와 리드타임",
    h("p", { class: "hint" }, "착수부터 인도까지 하루하루가 어디에 쓰였는지. 작업과 운반 외의 칸이 손실입니다."),
    h("div", { class: "lead-list" },
      h("div", { class: "lead-row lead-head" }, h("span", null, "배"), h("span", null, "리드타임 분해"), h("span", { class: "r" }, "리드"),
        h("span", { class: "r" }, "착수"), h("span", { class: "r" }, "인도 / 납기"), h("span", { class: "r" }, "지연")),
      result.ships.map((ship) => h("div", { class: "lead-row" },
        h("span", { class: "lead-name" }, h("b", null, ship.id), h("small", null, ship.type_name)),
        breakdownBar(ship, scale),
        h("span", { class: "lead-total" }, `${ship.lead_time}일`),
        h("span", { class: "r" }, ship.started_day ? `${ship.started_day}일` : "—"),
        h("span", { class: "r", title: ship.buffer_days ? `원래 납기 ${ship.base_due_day}일 + 공정 여유 ${ship.buffer_days}일, 선가 ${num(ship.base_price ?? ship.price)} → ${num(ship.price)}` : undefined },
          `${ship.delivered_day ? `${ship.delivered_day}일` : "미인도"} / ${ship.due_day}일${ship.buffer_days ? ` (+${ship.buffer_days})` : ""}`),
        h("span", { class: `r ${ship.late_days ? "bad" : "good"}` }, ship.late_days ? `${ship.late_days}일` : "없음")))),
    breakdownLegend(),
  );

  const rules = scenario.rules;
  const fastest = Math.max(...Object.values(rules.methods).map((m) => m.speed));
  // 나눠 하기를 쓴 회차만 짝 대기 칸을 보인다(3.0)
  const split = result.stations.some((st) => (st.pair_wait_days ?? 0) > 0);
  const skipped = new Set(scenario.skip ?? []);
  const oeeCard = card("공정별 OEE (설비 종합 효율)",
    h("table", { class: "oee" },
      h("thead", null, h("tr", null,
        h("th", null, "공정"), h("th", { class: "r" }, "최대/일"), h("th", { class: "r" }, "불량률"),
        h("th", { class: "r" }, "시간가동률"), h("th", { class: "r" }, "성능가동률"), h("th", { class: "r" }, "양품률"),
        h("th", null, "OEE"),
        split ? h("th", { class: "r", title: "나눠 하기에서 먼저 끝난 부분이 나머지를 기다린 날(작업장마다 합)" }, "짝 대기") : null)),
      h("tbody", null, result.stations.filter((st) => !skipped.has(st.id)).map((st) => h("tr", null,
        h("td", null, h("span", { class: "dot", style: { background: STATION_COLOR[st.id] } }), st.name),
        h("td", { class: "r" }, num(st.max_rate, 3)),
        h("td", { class: "r" }, pct(st.defect_rate, 0)),
        h("td", { class: "r", title: `가동 ${st.busy_days}일 · 사고 ${st.accident_stop_days} · 고장 ${st.breakdown_stop_days} · 자재 대기 ${st.material_wait_days} · 인력 대기 ${st.labor_wait_days}` },
          pct(st.oee.availability)),
        h("td", { class: "r" }, pct(st.oee.performance)),
        h("td", { class: "r" }, pct(st.oee.quality)),
        h("td", { class: "oee-cell" },
          h("span", { class: "meter" }, h("i", { style: { width: `${(st.oee.oee ?? 0) * 100}%` } })),
          h("b", null, pct(st.oee.oee))),
        split ? h("td", { class: "r" }, st.pair_wait_days ? `${st.pair_wait_days}일` : "–") : null)))),
    h("p", { class: "hint" },
      `OEE = 시간가동률 × 성능가동률 × 양품률. 성능가동률의 기준은 최대 처리량 ${num(maxRate, 3)}/일 `,
      `(${rules.max_workers_per_station}명 × 속도 ${num(fastest)} × 잔업 ${num(rules.overtime.speed, 2)})입니다.`,
      split ? " 짝 대기는 나눠 한 배의 먼저 끝난 부분이 나머지를 기다린 날입니다. 그 작업장은 비어 다른 배를 받을 수 있어 OEE에는 넣지 않고, 배의 리드타임에서는 작업으로 셉니다." : ""),
  );

  const invCard = card("재고 금액 추이",
    inventoryChart(result.inventory_value_daily),
    h("p", { class: "hint" }, `재고비 = 매일 재고 금액의 1%, 합계 ${money(result.costs.holding)}. 일찍 발주할수록 면적이 커집니다.`));

  const important = new Set(["defect", "accident", "breakdown", "delivery", "arrival", "supply_delay", "research_done"]);
  const eventList = h("ol", { class: "events" }, result.events.map((ev) =>
    h("li", { class: `${eventTone(ev)}${important.has(ev.type) ? "" : " minor"}` },
      h("span", { class: "ev-day" }, `${ev.day}일`),
      h("span", { class: `ev-type ${ev.type}` }, EVENT_NAME[ev.type]),
      h("span", null, eventText(ev, scenario)))));
  const eventsCard = card("사건 기록",
    h("label", { class: "inline-check" },
      h("input", {
        type: "checkbox",
        onchange: (e: Event) => eventList.classList.toggle("show-minor", (e.target as HTMLInputElement).checked),
      }),
      "투입, 완료, 출고, 운반도 보기"),
    eventList);

  for (const c of [qualityCard, oeeCard, leadCard, safetyCard]) c.classList.add("wide");
  // C: 원가 내역(긴 카드) 옆에 인력 가동과 재고 금액 추이를 위아래로
  const costSide = h("div", { class: "card-stack" }, laborCard, invCard);
  // 위(늘 보임): 등급, 의문점, QCD 세 숫자. 아래: Q·C·D 칸마다 근거 카드(접기), 끝에 사건 기록
  return h("div", { class: "report" },
    h("div", { class: "report-top" }, gradeCard(result.grade), findingRow),
    qcdRow,
    qcdSection("q", "Q", "품질", `직행률 ${pct(qcd.quality.first_pass_yield)} · 불량 ${status.defects}건 · 설비 고장 ${status.breakdowns}건`,
      qualityCard, oeeCard),
    qcdSection("c", "C", "원가", `이익 ${money(result.profit)} · 매출 ${money(result.revenue)} − 총원가 ${money(result.total_cost)} · 재고비 ${money(result.costs.holding)} · 가동률 ${pct(wf.utilization)}`,
      costCard, costSide),
    qcdSection("d", "D", "납기", `준수 ${qcd.delivery.on_time} / ${qcd.delivery.ships}척 · 총 지연 ${qcd.delivery.total_late_days}일 · 인도 ${status.delivered}척 · 진행 중 ${status.in_progress}척`,
      leadCard),
    qcdSection("s", "S", "안전", `잔업 사고 ${safety.accidents}건 · 사고로 멈춘 날 ${safety.stop_days}일 · 잔업 ${safety.overtime_days}일${safetyWarnings === undefined ? "" : ` · 현장 안전 경고 ${safetyWarnings}회`}`,
      safetyCard),
    qcdSection("events", null, "사건 기록", `${result.events.filter((ev) => important.has(ev.type)).length}건(주요 사건)`, eventsCard));
}

// 선배의 팁(4.23): 이번 회차 한 줄(엔진의 grade.to_s)과 반기마다 정한 팁(시나리오 tips). 문구는 항목마다 정해 둔 것만 고른다.
const FOCUS_TIP: Record<string, string> = {
  revenue: "인도 매출이 가장 많이 남았어. 기간 안에 인도하지 못한 배가 있다는 뜻이야. 착수를 당기거나 병목을 풀어 봐.",
  profit: "이익이 가장 많이 남았어. 쉰 인일, 재고비, 잔업처럼 돈만 나가는 칸부터 줄여 봐(평가서 C 원가).",
  delivery: "납기를 놓친 배가 있어. 평가서 D 납기에서 리드타임이 어디서 샜는지 봐.",
  quality: "직행률이 90%에 못 미쳐. 위 부록의 품질 포인트를 봐.",
};

/** 블록 우선순위 추천(4.25, D71): 블록 순서를 비우고 규칙만 바꿔 더 돌린 네 결과와 지금 계획. 실행 뒤에만 보인다.
 *  순위는 엔진이 정했다(인도 납기 → 블록 납기 → 이익 → 직행률). 화면은 숫자를 옮겨 적기만 한다. */
function recommendCard(result: Result, onApplyRule?: (rule: DispatchRule) => void): HTMLElement | null {
  const rc = result.recommend;
  if (!rc) return null;
  const best = rc.rules.find((r) => r.rule === rc.best)!;
  const ships = result.qcd.delivery.ships;
  const rate = (v: number | null) => (v === null ? "—" : pct(v, 0));
  const row = (label: string, m: DispatchMetrics, cls: string) =>
    h("tr", { class: cls }, h("th", null, label), h("td", null, `${m.on_time}/${ships}척`), h("td", null, rate(m.block_rate)),
      h("td", null, money(m.profit)), h("td", null, rate(m.first_pass_yield)));
  const diff = (name: string, a: number, b: number, unit: string, digits = 0) =>
    (a === b ? null : `${name} ${a > b ? "+" : "−"}${num(Math.abs(a - b), digits)}${unit}`);
  const gains = [
    diff("인도 납기", best.on_time, rc.current.on_time, "척"),
    best.block_rate !== null && rc.current.block_rate !== null
      ? diff("블록 납기", Math.round(best.block_rate * 100), Math.round(rc.current.block_rate * 100), "%p") : null,
    diff("이익", best.profit, rc.current.profit, "", 1),
  ].filter(Boolean);
  return h("div", { class: "tip-recommend" },
    h("h4", null, "블록 우선순위"),
    rc.current_is_best
      ? h("p", null, h("b", null, "지금 계획이 네 규칙보다 못하지 않아."), " 블록 순서를 잘 정했어.")
      : h("p", null, "블록 공정을 ", h("b", null, DISPATCH_INFO[rc.best].name), "으로 하면 ",
        gains.length ? `${gains.join(", ")}.` : "같은 결과에 순위가 앞서.",
        " 납기(D)를 먼저 보고, 같으면 이익(C)·직행률(Q)로 골랐어."),
    best.on_time < ships
      ? h("p", null, "규칙만 바꿔서는 납기를 못 맞추는 배가 있어. 블록 공정 앞(절단·가공)은 배 우선순위대로 하니까 ① 수주 목록의 우선순위부터 봐.")
      : null,
    h("table", { class: "tip-table" },
      h("thead", null, h("tr", null, h("th", null, "규칙"), h("th", null, "인도 납기"), h("th", null, "블록 납기"), h("th", null, "이익"), h("th", null, "직행률"))),
      h("tbody", null,
        rc.rules.map((r) => row(DISPATCH_INFO[r.rule].name, r, r.rule === rc.best ? "tip-best" : "")),
        row(rc.current.block_order ? "지금 계획(정한 순서)" : "지금 계획", rc.current, "tip-now"))),
    !rc.current_is_best && onApplyRule
      ? h("button", { type: "button", class: "btn small", onclick: () => onApplyRule(rc.best) },
        `추천대로 다시 계획(${DISPATCH_INFO[rc.best].name})`)
      : null);
}

function tipsCard(grade: Grade, scenario: Scenario): HTMLElement {
  const toS = grade.to_s;
  const lead = !toS ? null
    : toS.need > 0 ? h("p", { class: "tip-lead" }, h("b", null, `S까지 ${toS.need.toFixed(1)}점.`), " ", toS.focus ? FOCUS_TIP[toS.focus] ?? "" : "")
      : h("p", { class: "tip-lead" }, h("b", null, "S, 잘했어."), " ",
        toS.focus === "profit" ? `이익 점수는 목표를 넘어도 ${num(grade.parts.find((p) => p.key === "profit")?.max ?? 0)}점까지 올라가. 더 짜낼 데가 있는지 봐.`
          : toS.focus ? FOCUS_TIP[toS.focus] ?? "" : "더 볼 게 없네. 다음 반기로 가 봐.");
  return h("section", { class: "tips" },
    h("h3", { class: "tips-title" }, "선배의 팁"),
    lead,
    scenario.tips?.length ? h("ul", { class: "tips-list" }, scenario.tips.map((t) => h("li", null, t))) : null,
    h("p", { class: "tips-sign" }, `— ${AUTHOR} 선배`));
}

/** 평가서 뒤에 같은 클립보드에 끼운 메모 한 장: 부록 7관리 지표와 선배의 팁(4.23). 등급과 무관한 "더 나은 결과"를 위한 종이다. */
export function renderMemo(result: Result, scenario: Scenario, safetyWarnings?: number): HTMLElement {
  return h("div", { class: "memo-sheet" },
    // 부록(4.15): 옛 회차 결과에는 management가 없어 칸을 그리지 않는다
    result.management
      ? qcdSection("mgmt", "부록", "7관리 지표",
        `개선 포인트 ${MGMT_ROWS.filter(({ key }) => result.management![key].point).length}개 / 6요소`,
        mgmtCard(result.management, scenario, safetyWarnings))
      : null,
    tipsCard(result.grade, scenario));
}

/** 조립 공정 실적서(4.25, D71): 블록 조립 실습의 평가서 클립보드에 끼운 낱장. 조립 공정에 대한 결과를 모은다.
 *  블록 납기 준수 요약, 배별 공정 납기 준수, 블록 우선순위 추천. 등급 점수와는 무관하다. 스크롤 없이 한 장에 든다. */
export function renderAssemblyReport(result: Result, scenario: Scenario, onApplyRule?: (rule: DispatchRule) => void): HTMLElement | null {
  const bd = result.block_due;
  if (!bd || !result.blocks) return null;
  const stations = activeStationsOf(scenario);
  const blockSt = new Set(result.blocks.map((b) => b.station));
  // 공정별 블록 납기 준수(블록 공정만)
  const perStation = stations.filter((st) => blockSt.has(st.id)).map((st) => {
    const bs = result.blocks!.filter((b) => b.station === st.id);
    return { st, on: bs.filter((b) => b.on_time).length, n: bs.length, late: bs.reduce((a, b) => a + b.late_days, 0) };
  });
  const summary = h("div", { class: "asm-summary" },
    h("div", { class: "qcd-card" }, h("small", null, "블록 납기 준수"), h("b", null, `${bd.on_time} / ${bd.blocks}`),
      h("span", null, `준수율 ${bd.rate === null ? "—" : pct(bd.rate, 0)} · 늦은 날 합 ${bd.late_days}일`)),
    h("table", { class: "tip-table asm-station-table" },
      h("thead", null, h("tr", null, h("th", null, "블록 공정"), h("th", null, "지킨 블록"), h("th", null, "늦은 날 합"))),
      h("tbody", null, perStation.map((r) => h("tr", null,
        h("th", null, h("i", { class: "swatch", style: { background: STATION_COLOR[r.st.id] } }), r.st.name),
        h("td", null, `${r.on} / ${r.n}`), h("td", null, `${r.late}일`))))));
  // 배별 공정 납기: 마친 날 / 공정 납기, 넘겼으면 붉게
  const dueTable = h("table", { class: "tip-table asm-due-table" },
    h("thead", null, h("tr", null, h("th", null, "배"), stations.map((st) => h("th", null, st.name)))),
    h("tbody", null, result.ships.map((sh) => h("tr", null,
      h("th", null, sh.id),
      stations.map((st) => {
        const d = sh.station_dues?.[st.id];
        if (!d) return h("td", null, "—");
        return h("td", { class: d.late_days ? "late" : "", title: `공정 납기 ${d.due}일` },
          d.end === null ? "못 마침" : `${d.end}일`, h("small", null, d.late_days ? ` +${d.late_days}` : ""));
      })))));
  return h("div", { class: "asm-report" },
    h("section", { class: "report-sec" }, h("h3", null, "블록 납기"), summary),
    h("section", { class: "report-sec" }, h("h3", null, "공정 납기 (마친 날, 붉은 칸은 납기를 넘김)"), dueTable),
    h("section", { class: "report-sec" }, recommendCard(result, onApplyRule)));
}

function activeStationsOf(scenario: Scenario) {
  return scenario.stations.filter((st) => !scenario.skip?.includes(st.id));
}
