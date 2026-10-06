// 한 회차의 레포트: QCD, 현황, 원가 내역, 리드타임 분해, 작업장별 OEE, 사건 기록.
// 모든 숫자는 엔진 결과에 있는 값이다. 막대 길이를 정하는 비율만 화면에서 구한다.

import type { Result, Scenario, ShipResult, SimEvent } from "./api";
import { h, money, num, pct } from "./dom";
import { BREAKDOWN_STATES, COST_ITEMS, EVENT_NAME, STATION_COLOR } from "./labels";

export function eventText(ev: SimEvent, scenario: Scenario): string {
  const station = (id: string) => scenario.stations.find((st) => st.id === id)?.name ?? id;
  const material = (id: string) => scenario.materials.find((m) => m.id === id)?.name ?? id;
  switch (ev.type) {
    case "arrival": return `${material(ev.material)} ${ev.quantity}개 입고 (${ev.ship}용)`;
    case "enter": return `${ev.ship} ${station(ev.station)} 투입`;
    case "complete": return `${ev.ship} ${station(ev.station)} 완료`;
    case "defect": return `${ev.ship} ${station(ev.station)} 검사 불량 → 재작업`;
    case "accident": return `${station(ev.station)} 잔업 사고 → 3일 중지`;
    case "delivery": return ev.late_days > 0 ? `${ev.ship} 인도, ${ev.late_days}일 지연` : `${ev.ship} 인도, 납기 준수`;
  }
}

function eventTone(ev: SimEvent): string {
  if (ev.type === "defect" || ev.type === "accident") return "bad";
  if (ev.type === "delivery") return ev.late_days > 0 ? "bad" : "good";
  return "";
}

/** 리드타임 분해 막대 하나. scale은 막대 전체 폭에 해당하는 일수. */
export function breakdownBar(ship: ShipResult, scale: number): HTMLElement {
  return h("div", { class: "stack", title: `${ship.id} 리드타임 ${ship.lead_time}일` },
    BREAKDOWN_STATES.map((b) => {
      const days = ship.breakdown[b.state] ?? 0;
      if (!days) return null;
      return h("span", {
        class: "stack-part",
        style: { width: `${(days / scale) * 100}%`, background: b.color },
        title: `${b.name} ${days}일`,
      }, days >= 2 ? String(days) : "");
    }));
}

export function breakdownLegend(): HTMLElement {
  return h("div", { class: "legend" },
    BREAKDOWN_STATES.map((b) => h("span", null, h("i", { style: { background: b.color } }), b.name)));
}

function card(title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "card" }, h("h3", null, title), ...body);
}

export function renderReport(result: Result, scenario: Scenario, maxRate: number): HTMLElement {
  const { qcd, status } = result;
  const profitTone = result.profit >= 0 ? "good" : "bad";

  const qcdRow = h("div", { class: "qcd" },
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag q" }, "Q 품질"),
      h("b", { class: "kpi-value" }, pct(qcd.quality.first_pass_yield)),
      h("span", { class: "kpi-sub" }, `직행률 · 첫 검사 합격 ${qcd.quality.passes} / ${qcd.quality.inspections}`)),
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag c" }, "C 원가"),
      h("b", { class: `kpi-value ${profitTone}` }, money(result.profit)),
      h("span", { class: "kpi-sub" }, `이익 · 매출 ${money(result.revenue)} − 총원가 ${money(result.total_cost)}`)),
    h("div", { class: "kpi" },
      h("span", { class: "kpi-tag d" }, "D 납기"),
      h("b", { class: `kpi-value ${qcd.delivery.on_time === qcd.delivery.ships ? "good" : "bad"}` },
        `${qcd.delivery.on_time} / ${qcd.delivery.ships}척`),
      h("span", { class: "kpi-sub" }, `납기 준수 ${pct(qcd.delivery.on_time_rate, 0)} · 총 지연 ${qcd.delivery.total_late_days}일`)),
  );

  const statusCard = card("현황",
    h("dl", { class: "status" },
      h("div", null, h("dt", null, "인도"), h("dd", null, `${status.delivered}척`)),
      h("div", null, h("dt", null, "진행 중"), h("dd", null, `${status.in_progress}척`)),
      h("div", null, h("dt", null, "미착수"), h("dd", null, `${status.not_started}척`)),
      h("div", null, h("dt", null, "불량"), h("dd", { class: status.defects ? "bad" : "" }, `${status.defects}건`)),
      h("div", null, h("dt", null, "사고"), h("dd", { class: status.accidents ? "bad" : "" }, `${status.accidents}건`))),
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
    h("p", { class: "hint" }, "착수부터 인도까지 하루하루가 어디에 쓰였는지. 작업 외의 칸이 손실입니다."),
    h("div", { class: "lead-list" }, result.ships.map((ship) => h("div", { class: "lead-row" },
      h("span", { class: "lead-name" }, h("b", null, ship.id)),
      breakdownBar(ship, scale),
      h("span", { class: "lead-total" }, `${ship.lead_time}일`)))),
    breakdownLegend(),
  );

  const rules = scenario.rules;
  const fastest = Math.max(...Object.values(rules.methods).map((m) => m.speed));
  const oeeCard = card("작업장별 OEE",
    h("table", { class: "oee" },
      h("thead", null, h("tr", null,
        h("th", null, "작업장"), h("th", { class: "r" }, "처리량/일"), h("th", { class: "r" }, "불량률"),
        h("th", { class: "r" }, "시간가동률"), h("th", { class: "r" }, "성능가동률"), h("th", { class: "r" }, "양품률"),
        h("th", null, "OEE"))),
      h("tbody", null, result.stations.map((st) => h("tr", null,
        h("td", null, h("span", { class: "dot", style: { background: STATION_COLOR[st.id] } }), st.name),
        h("td", { class: "r" }, num(st.rate, 3)),
        h("td", { class: "r" }, pct(st.defect_rate, 0)),
        h("td", { class: "r" }, pct(st.oee.availability)),
        h("td", { class: "r" }, pct(st.oee.performance)),
        h("td", { class: "r" }, pct(st.oee.quality)),
        h("td", { class: "oee-cell" },
          h("span", { class: "meter" }, h("i", { style: { width: `${(st.oee.oee ?? 0) * 100}%` } })),
          h("b", null, pct(st.oee.oee))))))),
    h("p", { class: "hint" },
      `OEE = 시간가동률 × 성능가동률 × 양품률. 성능가동률의 기준은 최대 처리량 ${num(maxRate, 3)}/일 `,
      `(${rules.max_workers_per_station}명 × 속도 ${num(fastest)} × 잔업 ${num(rules.overtime.speed, 2)})입니다.`),
  );

  const important = new Set(["defect", "accident", "delivery", "arrival"]);
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
      "투입과 완료도 보기"),
    eventList);

  return h("div", { class: "report" },
    qcdRow,
    h("div", { class: "report-grid" }, statusCard, costCard, leadCard, oeeCard, eventsCard));
}
