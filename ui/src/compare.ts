// 두 회차 비교: 설정 차이, QCD 차이, 원가 차이, 리드타임 분해 차이.
// 같은 수주와 같은 난수로 돌렸으므로, 결과 차이는 오직 설정 차이에서 나온다.

import type { Config, Result, Scenario } from "./api";
import { h, money, num, pct, signed } from "./dom";
import { BREAKDOWN_STATES, COST_ITEMS } from "./labels";
import { breakdownBar, breakdownLegend } from "./report";

export interface Run {
  n: number;
  label: string;
  config: Config;
  result: Result;
}

interface Change {
  what: string;
  a: string;
  b: string;
}

function configChanges(a: Config, b: Config, scenario: Scenario): Change[] {
  const changes: Change[] = [];
  const add = (what: string, va: string, vb: string) => { if (va !== vb) changes.push({ what, a: va, b: vb }); };
  const day = (v: number | null | undefined) => (v === null || v === undefined ? "발주 안 함" : `${v}일`);
  const methodName = (id: string) => scenario.rules.methods[id]?.name ?? id;
  const stationName = (id: string | null) =>
    id === null ? "미배치" : scenario.stations.find((st) => st.id === id)?.name ?? id;

  for (const order of scenario.orders) {
    const sa = a.ships[order.id];
    const sb = b.ships[order.id];
    add(`${order.id} 우선순위`, `${sa.priority}순위`, `${sb.priority}순위`);
    add(`${order.id} 착수일`, `${sa.start_day}일`, `${sb.start_day}일`);
    for (const m of scenario.materials) {
      add(`${order.id} ${m.name} 발주일`, day(sa.order_days[m.id]), day(sb.order_days[m.id]));
    }
  }
  for (const st of scenario.stations) {
    const ca = a.stations[st.id];
    const cb = b.stations[st.id];
    add(`${st.name} 작업자`, `${ca.workers}명`, `${cb.workers}명`);
    add(`${st.name} 공법`, methodName(ca.method), methodName(cb.method));
    add(`${st.name} 잔업`, ca.overtime ? "함" : "안 함", cb.overtime ? "함" : "안 함");
    add(`${st.name} 정비`, ca.maintenance ? "함" : "안 함", cb.maintenance ? "함" : "안 함");
  }
  add("숙련공", stationName(a.skilled_station), stationName(b.skilled_station));
  return changes;
}

/** 차이 칸. better가 "up"이면 늘어난 것이 개선이다. 색과 함께 글자로도 개선/악화를 적는다. */
function deltaCell(diff: number, better: "up" | "down", format: (v: number) => string): HTMLElement {
  if (Math.abs(diff) < 1e-9) return h("td", { class: "r delta same" }, "같음");
  const good = better === "up" ? diff > 0 : diff < 0;
  return h("td", { class: `r delta ${good ? "good" : "bad"}` },
    signed(diff, format), h("small", null, good ? " 개선" : " 악화"));
}

export function renderCompare(runs: Run[], aIndex: number, bIndex: number, scenario: Scenario,
                              onPick: (side: "a" | "b", index: number) => void): HTMLElement {
  const picker = (side: "a" | "b", current: number) =>
    h("select", { onchange: (e: Event) => onPick(side, Number((e.target as HTMLSelectElement).value)) },
      runs.map((run, i) => h("option", { value: i, selected: i === current }, `${run.n}회차 · ${run.label}`)));

  const head = h("div", { class: "compare-head" },
    h("span", { class: "side-tag a" }, "A"), picker("a", aIndex),
    h("span", { class: "vs" }, "와"),
    h("span", { class: "side-tag b" }, "B"), picker("b", bIndex),
    h("span", { class: "hint" }, "같은 수주 · 같은 난수"));

  const A = runs[aIndex];
  const B = runs[bIndex];
  if (!A || !B) return h("div", { class: "compare" }, head);
  const ra = A.result;
  const rb = B.result;

  // 설정 차이
  const changes = configChanges(A.config, B.config, scenario);
  const settingsCard = h("div", { class: "card" },
    h("h3", null, "설정 차이"),
    changes.length === 0
      ? h("p", { class: "same-note" },
        "두 회차의 설정이 같습니다. 엔진은 결정적이라 결과도 한 자리까지 같습니다.")
      : h("table", { class: "diff" },
        h("thead", null, h("tr", null, h("th", null, "항목"), h("th", null, "A"), h("th", null, "B"))),
        h("tbody", null, changes.map((c) => h("tr", null,
          h("td", null, c.what), h("td", null, c.a), h("td", null, h("b", null, c.b)))))));

  // QCD 차이
  type Metric = { name: string; a: number; b: number; better: "up" | "down"; show: (v: number) => string; diff: (v: number) => string };
  const yieldA = ra.qcd.quality.first_pass_yield ?? 0;
  const yieldB = rb.qcd.quality.first_pass_yield ?? 0;
  const metrics: Metric[] = [
    { name: "Q 직행률", a: yieldA, b: yieldB, better: "up", show: (v) => pct(v), diff: (v) => `${(v * 100).toFixed(1)}%p` },
    { name: "Q 불량", a: ra.status.defects, b: rb.status.defects, better: "down", show: (v) => `${v}건`, diff: (v) => `${v}건` },
    { name: "C 총원가", a: ra.total_cost, b: rb.total_cost, better: "down", show: money, diff: money },
    { name: "C 이익", a: ra.profit, b: rb.profit, better: "up", show: money, diff: money },
    { name: "D 납기 준수", a: ra.qcd.delivery.on_time, b: rb.qcd.delivery.on_time, better: "up", show: (v) => `${v}척`, diff: (v) => `${v}척` },
    { name: "D 총 지연일", a: ra.qcd.delivery.total_late_days, b: rb.qcd.delivery.total_late_days, better: "down", show: (v) => `${v}일`, diff: (v) => `${v}일` },
    { name: "사고", a: ra.status.accidents, b: rb.status.accidents, better: "down", show: (v) => `${v}건`, diff: (v) => `${v}건` },
  ];
  const qcdCard = h("div", { class: "card" },
    h("h3", null, "QCD 차이"),
    h("table", { class: "diff num" },
      h("thead", null, h("tr", null, h("th", null, "지표"), h("th", { class: "r" }, "A"), h("th", { class: "r" }, "B"), h("th", { class: "r" }, "B − A"))),
      h("tbody", null, metrics.map((m) => h("tr", null,
        h("td", null, m.name), h("td", { class: "r" }, m.show(m.a)), h("td", { class: "r" }, m.show(m.b)),
        deltaCell(m.b - m.a, m.better, m.diff))))));

  // 원가 차이
  const costCard = h("div", { class: "card" },
    h("h3", null, "원가 차이"),
    h("table", { class: "diff num" },
      h("thead", null, h("tr", null, h("th", null, "항목"), h("th", { class: "r" }, "A"), h("th", { class: "r" }, "B"), h("th", { class: "r" }, "B − A"))),
      h("tbody", null,
        COST_ITEMS.map((item) => {
          const va = ra.costs[item.key] ?? 0;
          const vb = rb.costs[item.key] ?? 0;
          return h("tr", { title: item.note },
            h("td", null, item.name), h("td", { class: "r" }, money(va)), h("td", { class: "r" }, money(vb)),
            deltaCell(vb - va, "down", money));
        }),
        h("tr", { class: "total" },
          h("td", null, "총원가"), h("td", { class: "r" }, money(ra.total_cost)), h("td", { class: "r" }, money(rb.total_cost)),
          deltaCell(rb.total_cost - ra.total_cost, "down", money)),
        h("tr", { class: "total" },
          h("td", null, "이익"), h("td", { class: "r" }, money(ra.profit)), h("td", { class: "r" }, money(rb.profit)),
          deltaCell(rb.profit - ra.profit, "up", money)))));

  // 리드타임 분해 차이: 배마다 A, B 막대를 같은 눈금으로 나란히
  const scale = Math.max(1, ...ra.ships.map((s) => s.lead_time), ...rb.ships.map((s) => s.lead_time));
  const leadCard = h("div", { class: "card wide" },
    h("h3", null, "리드타임 분해 차이"),
    h("div", { class: "lead-compare" }, ra.ships.map((shipA, i) => {
      const shipB = rb.ships[i];
      const parts = BREAKDOWN_STATES
        .map((b) => ({ name: b.name, d: (shipB.breakdown[b.state] ?? 0) - (shipA.breakdown[b.state] ?? 0) }))
        .filter((p) => p.d !== 0);
      return h("div", { class: "lead-pair" },
        h("div", { class: "lead-pair-head" },
          h("b", null, shipA.id), h("small", null, shipA.type_name),
          h("span", { class: "lead-change" },
            parts.length ? parts.map((p) => `${p.name} ${signed(p.d, (v) => num(v, 0))}일`).join(" · ") : "차이 없음")),
        h("div", { class: "lead-row" }, h("span", { class: "side-tag a" }, "A"), breakdownBar(shipA, scale), h("span", { class: "lead-total" }, `${shipA.lead_time}일`)),
        h("div", { class: "lead-row" }, h("span", { class: "side-tag b" }, "B"), breakdownBar(shipB, scale), h("span", { class: "lead-total" }, `${shipB.lead_time}일`)));
    })),
    breakdownLegend());

  return h("div", { class: "compare" }, head,
    h("div", { class: "report-grid" }, settingsCard, qcdCard, costCard, leadCard));
}
