// 조립과 연결된 것(4.30, D77): 블록 실습 관제실 오른쪽 모니터 "전체" 화면 구석의 카드.
// 사용자(2026-10-17): 조립 공정에서 거슬러 올라가 "전체"를 볼 때 알고 싶은 두 가지.
//   ① 자재: 조립 공정이 쓸 자재 키트가 아직 작업장에 없으면 물류창고에 언제 들어오는지.
//      계획 입고일(발주일 + 리드타임)을 적고, 입고 지연은 알게 된 날(원래 입고일)부터 늦어진 날을 적는다(결과를 미리 알려 주지 않는다).
//   ② 후행 공정: 앞 공정을 끝내고 다음 공정 앞에 와서 짝 블록을 기다리는 블록과, 그 짝이 지금 무엇을 하는지.
// 엔진 결과(ships의 발주·입고일, 사건, blocks[].daily)에서 그날 것을 고르기만 한다.

import { blockLabel, blockStations, type Result, type Scenario } from "./api";
import { h } from "./dom";
import { STATE_INFO } from "./labels";

const STATE_WORD: Record<string, string> = {
  work: "작업 중", rework: "재작업 중", not_started: "착수 전", transport: "운반 중", pair_wait: "도착(짝 대기)",
};

export function renderAsmWatch(result: Result, scenario: Scenario, day: number): HTMLElement | null {
  const bst = blockStations(scenario);
  if (!bst.length || !result.blocks) return null;
  const name = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const matName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  const lead = Object.fromEntries(scenario.materials.map((m) => [m.id, m.lead_days]));

  // ① 자재: 조립 공정 가운데 자재를 쓰는 공정, 배마다 키트를 아직 내주지 않았으면
  const mats: HTMLElement[] = [];
  for (const b of bst) {
    const mid = scenario.stations.find((st) => st.id === b.id)?.material;
    if (!mid) continue;
    for (const sh of result.ships) {
      if (sh.started_day === null || sh.started_day > day) continue;
      if (!scenario.ship_types[sh.type].bom[mid]) continue;
      const issued = result.events.some((e) => e.type === "issue" && e.ship === sh.id && e.station === b.id && e.day <= day);
      if (issued) continue;
      const orderDay = sh.order_days[mid];
      const planned = orderDay === undefined ? null : orderDay + lead[mid];
      const delay = result.events.find((e) => e.type === "supply_delay" && e.ship === sh.id && e.material === mid && e.day <= day);
      const arrive = delay && delay.type === "supply_delay" ? delay.arrival_day : planned;
      const what = `${sh.id} ${b.name} ${matName[mid]} 키트`;
      const text = planned === null ? "아직 발주 전"
        : arrive !== null && arrive <= day ? "창고에 입고됨 · 지게차가 작업장으로 싣기를 기다림"
        : delay && delay.type === "supply_delay" ? `창고 입고 ${arrive}일 예정 (원래 ${planned}일, ${delay.days}일 지연)`
        : `창고 입고 ${planned}일 예정 (D-${planned - day})`;
      const blocked = result.blocks.some((x) => x.ship === sh.id && x.station === b.id && x.daily[day - 1]?.state === "material_wait");
      mats.push(h("li", { class: blocked ? "hot" : "" },
        h("b", null, what), " ", text, blocked ? h("em", null, " · 오늘 이 공정 블록이 자재 대기") : null));
    }
  }

  // ② 후행 공정 앞 짝 대기: 다음 공정 블록 하나를 이루는 블록 가운데 먼저 와서 기다리는 것
  const pairs: HTMLElement[] = [];
  for (let k = 0; k < bst.length - 1; k++) {
    const st = bst[k], nxt = bst[k + 1];
    const r = st.count / nxt.count;
    const mine = result.blocks.filter((b) => b.station === st.id);
    const groups = new Map<string, typeof mine>();
    for (const b of mine) {
      const key = `${b.ship}:${Math.floor((b.no - 1) / r) + 1}`;
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    for (const [key, group] of groups) {
      const arrived = group.filter((b) => b.daily[day - 1]?.state === "pair_wait");
      if (!arrived.length || arrived.length === group.length) continue;
      const [ship, no] = key.split(":");
      const rest = group.filter((b) => !arrived.includes(b));
      pairs.push(h("li", null,
        h("b", null, `${name[nxt.id]} ${ship} ${blockLabel(nxt.id, Number(no))} 앞`), " ",
        `${arrived.map((b) => blockLabel(st.id, b.no)).join("·")} 도착, 짝 `,
        rest.map((b, i) => {
          const state = b.daily[day - 1]?.state ?? "not_started";
          const word = STATE_WORD[state] ?? STATE_INFO[state]?.name ?? state;
          return [i ? ", " : "", h("span", { class: ["work", "rework", "transport"].includes(state) ? "" : "hot" }, `${blockLabel(st.id, b.no)} ${word}`)];
        })));
    }
  }

  return h("div", { class: "asm-watch" },
    h("b", { class: "asm-watch-title" }, "조립과 연결된 것", h("small", null, ` · ${day}일`)),
    h("div", null, h("small", null, "조립 자재"),
      mats.length ? h("ul", null, mats) : h("p", null, day ? "기다리는 자재 키트 없음" : "재생하면 보입니다")),
    h("div", null, h("small", null, "후행 공정 앞 짝 대기"),
      pairs.length ? h("ul", null, pairs) : h("p", null, "짝을 기다리는 블록 없음")));
}
