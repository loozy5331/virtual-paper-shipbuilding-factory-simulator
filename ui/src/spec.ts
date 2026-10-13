// 선박 사양서(4.17, D64): 생산계획서 ① 수주 목록에서 배를 누르면 펼쳐지는 종이 한 장.
// 외형(옆모습), 공정별 작업량·직종·자재·공법, 직종별 인력, 자재(BOM), 인도 기준을 보인다.
// 작업량과 직종 합계는 미리보기(/api/preview의 ships)에서 받고, 공법은 지금 계획서에서 고른 값을 비춘다. 화면은 계산하지 않는다.
// 인도 기준은 설명 글이다(엔진 규칙 아님). 엔진 규칙으로 만드는 일은 4.x 이후(D64 B안).

import type { Config, Preview, Scenario, TradeInfo } from "./api";
import { h, num, pct, s } from "./dom";
import { STATION_COLOR } from "./labels";
import { shipProfile } from "./profile";

/** 공정의 공법·인력 한 줄: "표준 · 숙련공 · 잔업", 호이스트·증설도 붙인다 */
function methodText(scenario: Scenario, config: Config, stationId: string, external: boolean): string {
  const cfg = config.stations[stationId];
  if (!cfg) return "";
  const parts = [scenario.rules.methods[cfg.method]?.name ?? cfg.method];
  if (external) parts.push(scenario.rules.crews.external?.name ?? "외부팀");
  else if (cfg.crew && cfg.crew !== "normal") parts.push(scenario.rules.crews[cfg.crew]?.name ?? cfg.crew);
  if (cfg.overtime && cfg.crew !== "robot" && !external) parts.push("잔업");
  if (cfg.hoist) parts.push(scenario.rules.hoist.name);
  if ((cfg.units ?? 1) > 1) parts.push(`작업장 ${cfg.units}`);
  return parts.join(" · ");
}

export function renderShipSpec(scenario: Scenario, config: Config, preview: Preview | null, shipId: string, onClose: () => void): HTMLElement {
  const order = scenario.orders.find((o) => o.id === shipId)!;
  const type = scenario.ship_types[order.type];
  const spec = preview?.ships?.[shipId];
  const contract = preview?.contract?.[shipId];
  const category = type.category ? scenario.ship_categories?.[type.category] : undefined;
  const trade = (id: string) => scenario.trades[id] as TradeInfo | undefined;
  const stationName = (id: string) => scenario.stations.find((st) => st.id === id)?.name ?? id;
  const material = (id: string) => scenario.materials.find((m) => m.id === id);

  // 외형: 물 위에 뜬 옆모습(시운전 그림을 두 배로)
  const W = 120, H = 40;
  const outline = s("svg", { class: "spec-profile", viewBox: `0 0 ${W} ${H}`, width: W * 2, height: H * 2, role: "img", "aria-label": `${type.name} 옆모습` },
    s("rect", { x: 0, y: 30, width: W, height: H - 30, class: "water" }),
    shipProfile(order.type, W / 2 - 3, 31));

  const due = contract?.due_day ?? order.due_day;
  const price = contract?.price ?? order.price;
  const head = h("div", { class: "spec-head" },
    outline,
    h("div", { class: "spec-id" },
      h("div", null, h("b", { class: "spec-ship" }, shipId), " ", h("span", { class: "spec-type" }, type.name),
        category && typeof category === "object" ? h("span", { class: "spec-cat" }, category.name) : null),
      type.spec ? h("p", null, type.spec.summary) : null,
      type.spec ? h("p", { class: "hint" }, type.spec.real) : null,
      h("p", { class: "spec-contract" }, `납기 ${due}일 · 선가 ${num(price)}`,
        contract?.buffer_days ? h("small", null, ` (공정 여유 +${contract.buffer_days}일)`) : null)));

  // 공정표: 공정 · 직종 · 작업량 · 자재 · 공법(계획서 ④에서 고른 값)
  const rows = spec?.stations ?? [];
  const processTable = h("table", { class: "plan spec-table spec-process" },
    h("thead", null, h("tr", null,
      h("th", null, "공정"), h("th", null, "직종"), h("th", { class: "r" }, "작업량"), h("th", null, "자재"), h("th", null, "공법·인력·설비"))),
    h("tbody", null, rows.map((r) => {
      const t = trade(r.trade);
      const m = r.material ? material(r.material) : undefined;
      return h("tr", null,
        h("td", null, h("i", { class: "swatch", style: { background: STATION_COLOR[r.station] } }), stationName(r.station)),
        h("td", null, t?.name ?? r.trade),
        h("td", { class: "r" }, num(r.work, 1)),
        h("td", null, m && r.quantity ? `${m.name} ${r.quantity}` : "—"),
        h("td", { class: "hint" }, methodText(scenario, config, r.station, !!t?.external)));
    })));

  // 인력: 직종별 이 배의 작업량과 계획서의 대기소 인원
  const people = h("div", { class: "spec-trades" },
    Object.entries(spec?.trades ?? {}).map(([id, work]) => {
      const t = trade(id);
      const pool = config.pools?.[id];
      return h("span", { class: "chip" }, h("b", null, t?.name ?? id), ` ${num(work, 1)}인·일`,
        t?.external ? h("small", null, " (외부팀)") : pool !== undefined ? h("small", null, ` · 대기소 ${pool}명`) : null);
    }));

  // 자재(BOM): 이 배 몫 수량, 쓰는 공정, 리드타임, 계획서의 발주 방식으로 정해진 발주·입고일
  const bom = rows.filter((r) => r.material && r.quantity);
  const bomTable = h("table", { class: "plan spec-table" },
    h("thead", null, h("tr", null,
      h("th", null, "자재"), h("th", { class: "r" }, "수량"), h("th", null, "쓰는 공정"), h("th", { class: "r" }, "리드타임"),
      h("th", { class: "r" }, "발주"), h("th", { class: "r" }, "입고"))),
    h("tbody", null, bom.map((r) => {
      const m = material(r.material!)!;
      const plan = preview?.materials?.[shipId]?.[m.id];
      return h("tr", null,
        h("td", null, m.name), h("td", { class: "r" }, r.quantity), h("td", null, stationName(r.station)),
        h("td", { class: "r" }, `${m.lead_days}일`),
        h("td", { class: "r" }, plan?.order_day ? `${plan.order_day}일` : "—"),
        h("td", { class: "r" }, plan?.arrival_day ? `${plan.arrival_day}일` : "—"));
    })));

  // 인도 기준(설명 글): 공통 + 지연 위약금 + 선종마다 덧붙는 조건
  const criteria = [
    ...(scenario.delivery?.criteria ?? []),
    `납기를 넘기면 하루마다 선가의 ${pct(scenario.rules.costs.late_penalty_rate_per_day, 0)}를 위약금으로 낸다. 기간 안에 인도하지 못하면 매출 없이 기간 끝날까지 쌓인다.`,
    ...(type.spec?.delivery ?? []),
  ];

  const close = h("button", { type: "button", class: "btn spec-close", "aria-label": "닫기", onclick: onClose }, "닫기");
  return h("div", { class: "spec-sheet paper", role: "dialog", "aria-label": `${shipId} 선박 사양서` },
    h("div", { class: "spec-title" }, h("h2", null, "선박 사양서"), close),
    head,
    type.spec ? h("p", { class: "spec-build" }, h("b", null, "건조 특징 "), type.spec.build) : null,
    h("h3", null, "공정과 작업량 ", h("small", null, "작업량 = 인·일(표준 공법 1명이 하루에 1). 공법·인력·설비는 지금 계획서의 값")),
    spec ? processTable : h("p", { class: "hint" }, "미리보기를 받는 중입니다."),
    h("h3", null, "인력 ", h("small", null, "직종별 이 배의 작업량")),
    people,
    h("h3", null, "자재 (BOM) ", h("small", null, "발주·입고일은 지금 고른 발주 방식으로 엔진이 정한 날")),
    bom.length ? bomTable : h("p", { class: "hint" }, "—"),
    h("h3", null, "인도 기준"),
    h("ul", { class: "spec-delivery" }, criteria.map((c) => h("li", null, c))));
}
