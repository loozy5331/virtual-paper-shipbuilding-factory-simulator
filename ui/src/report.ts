// 한 번의 실행 레포트: 등급, 의문점 카드, QCD, 현황, 원가 내역, 리드타임 분해, 공정별 OEE, 재고 금액 추이, 사건 기록.
// 모든 숫자는 엔진 결과에 있는 값이다. 막대 길이와 차트 좌표를 정하는 비율만 화면에서 구한다.

import type { Finding, Grade, Result, Scenario, ShipResult, SimEvent } from "./api";
import { h, money, num, pct, s, signed } from "./dom";
import { COST_ITEMS, EVENT_NAME, GRADE_COLOR, GRADE_NOTE, GRADE_TEXT, LEAD_TIME_STATES, STATE_INFO, STATION_COLOR } from "./labels";

export function eventText(ev: SimEvent, scenario: Scenario): string {
  const station = (id: string) => scenario.stations.find((st) => st.id === id)?.name ?? id;
  const material = (id: string) => scenario.materials.find((m) => m.id === id)?.name ?? id;
  switch (ev.type) {
    case "arrival": return `${material(ev.material)} ${ev.quantity}개 입고 (${ev.ship}용)`;
    case "issue": return `${material(ev.material)} ${ev.quantity}개 출고 → ${ev.ship} ${station(ev.station)}`;
    case "enter": return `${ev.ship} ${station(ev.station)} 투입${ev.units ? ` (${ev.units.join("·")}호에 나눠)` : ""}`;
    case "complete": return `${ev.ship} ${station(ev.station)} 완료`;
    case "defect": return `${ev.ship} ${station(ev.station)} 검사 불량 → 재작업`;
    case "accident": return `${station(ev.station)} 잔업 사고 → 3일 중지`;
    case "breakdown": return ev.transporter
      ? `트랜스포터 ${ev.transporter} 고장 → 2일 중지`
      : `${station(ev.station ?? "")} 설비 고장 → 2일 중지`;
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
  if (ev.type === "defect" || ev.type === "accident" || ev.type === "breakdown") return "bad";
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
  return h("div", { class: "legend" },
    LEAD_TIME_STATES.map((b) => h("span", null, h("i", { class: b.hatch ? "hatch-over" : "", style: { background: b.color } }), b.name)));
}

function card(title: string, ...body: (HTMLElement | SVGElement | null)[]): HTMLElement {
  return h("div", { class: "card" }, h("h3", null, title), ...body);
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
      h("p", { class: "hint" }, "점수 = 매출 30 + 이익 40(최대 52) + 납기 20 + 직행률 10 · S 105, A 85, B 70, C 50")));
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
  for (const d of [1, 10, 20, 30, 40, 50, 60]) {
    if (d <= values.length) svg.append(s("text", { x: px(d - 1), y: H - 6, class: "tick" }, `${d}일`));
  }
  // 마우스를 올릴 자리: 점보다 넓은 세로 띠
  values.forEach((v, i) => svg.append(
    s("rect", { x: px(i) - dx / 2, y: T, width: dx, height: H - T - B, class: "hit" },
      s("title", null, `${i + 1}일 재고 ${money(v)}`))));
  return svg;
}

export function renderReport(result: Result, scenario: Scenario, maxRate: number,
  onFinding: (f: Finding, where: "field" | "gantt") => void): HTMLElement {
  const { qcd, status } = result;
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
  );

  const wf = result.workforce;
  const statusCard = card("현황",
    h("dl", { class: "status" },
      h("div", null, h("dt", null, "인도"), h("dd", null, `${status.delivered}척`)),
      h("div", null, h("dt", null, "진행 중"), h("dd", null, `${status.in_progress}척`)),
      h("div", null, h("dt", null, "불량"), h("dd", { class: status.defects ? "bad" : "" }, `${status.defects}건`)),
      h("div", null, h("dt", null, "사고"), h("dd", { class: status.accidents ? "bad" : "" }, `${status.accidents}건`)),
      h("div", null, h("dt", null, "고장"), h("dd", { class: status.breakdowns ? "bad" : "" }, `${status.breakdowns}건`))),
    h("div", { class: "util" },
      h("span", null, "작업자 가동률"),
      h("span", { class: "meter wide" }, h("i", { style: { width: `${wf.utilization * 100}%` } })),
      h("b", null, pct(wf.utilization)),
      h("small", null, `배정 ${wf.man_days}인일 ÷ (${wf.pool}명 × ${result.days}일) · 쉰 인일 ${wf.idle_man_days}`)),
    h("table", { class: "ship-table" },
      h("thead", null, h("tr", null,
        h("th", null, "배"), h("th", { class: "r" }, "착수"), h("th", { class: "r" }, "인도"),
        h("th", { class: "r" }, "납기"), h("th", { class: "r" }, "지연"))),
      h("tbody", null, result.ships.map((ship) => h("tr", null,
        h("td", null, h("b", null, ship.id), " ", h("small", null, ship.type_name)),
        h("td", { class: "r" }, ship.started_day ? `${ship.started_day}일` : "—"),
        h("td", { class: "r" }, ship.delivered_day ? `${ship.delivered_day}일` : "미인도"),
        h("td", { class: "r" }, `${ship.due_day}일`),
        h("td", { class: `r ${ship.late_days ? "bad" : "good"}` }, ship.late_days ? `${ship.late_days}일` : "없음"))))),
  );

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
  const leadCard = card("리드타임 분해",
    h("p", { class: "hint" }, "착수부터 인도까지 하루하루가 어디에 쓰였는지. 작업과 운반 외의 칸이 손실입니다."),
    h("div", { class: "lead-list" }, result.ships.map((ship) => h("div", { class: "lead-row" },
      h("span", { class: "lead-name" }, h("b", null, ship.id)),
      breakdownBar(ship, scale),
      h("span", { class: "lead-total" }, `${ship.lead_time}일`)))),
    breakdownLegend(),
  );

  const rules = scenario.rules;
  const fastest = Math.max(...Object.values(rules.methods).map((m) => m.speed));
  // 나눠 하기를 쓴 회차만 짝 대기 칸을 보인다(3.0)
  const split = result.stations.some((st) => (st.pair_wait_days ?? 0) > 0);
  const oeeCard = card("공정별 OEE",
    h("table", { class: "oee" },
      h("thead", null, h("tr", null,
        h("th", null, "공정"), h("th", { class: "r" }, "최대/일"), h("th", { class: "r" }, "불량률"),
        h("th", { class: "r" }, "시간가동률"), h("th", { class: "r" }, "성능가동률"), h("th", { class: "r" }, "양품률"),
        h("th", null, "OEE"),
        split ? h("th", { class: "r", title: "나눠 하기에서 먼저 끝난 부분이 나머지를 기다린 날(작업장마다 합)" }, "짝 대기") : null)),
      h("tbody", null, result.stations.map((st) => h("tr", null,
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

  const important = new Set(["defect", "accident", "breakdown", "delivery", "arrival", "research_done"]);
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

  return h("div", { class: "report" },
    h("div", { class: "report-top" }, gradeCard(result.grade), findingRow),
    qcdRow,
    h("div", { class: "report-grid" }, statusCard, costCard, leadCard, oeeCard, invCard, eventsCard));
}
