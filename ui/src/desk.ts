// 첫 화면: 책상 위에 분기마다 클립보드가 하나씩 놓여 있다(클립보드 1개 = 시나리오 1개).
// 맨 위 종이는 그 분기의 "생산계획" 표지다. 왼쪽부터 옛 분기 → 나중 분기 순이고, 나중일수록 어렵다.
// 신입이 쉬운 분기부터 하나씩 맡으며 경험을 쌓는 흐름이다. 누르면 그 클립보드를 집어 들고 생산계획서가 열린다(main.ts).

import type { ClassBest, ScenarioSummary } from "./api";
import { h, mount, num } from "./dom";
import { GRADE_COLOR, GRADE_EDGE, GRADE_TEXT } from "./labels";

export interface DeskContext {
  scenarios: ScenarioSummary[];
  /** 이번 세션에서 분기마다 받은 최고 등급. 없으면 아직 맡지 않은 분기. */
  best: Record<string, { grade: string; score: number } | undefined>;
  /** 반 코드를 적었으면 그 반의 시나리오별 최고(서버 저장). */
  classCode: string;
  classBest: Record<string, ClassBest>;
  onPick(id: string, board: HTMLElement): void;
}

const LEVEL_NAME = ["", "입문", "중급", "고급", "심화"];

export function renderDesk(root: HTMLElement, ctx: DeskContext): void {
  const maxLevel = Math.max(...ctx.scenarios.map((sc) => sc.level));
  mount(root,
    h("div", { class: "desk-intro" },
      h("small", { class: "desk-brand" }, "종이배 조선소 · 생산관리 시뮬레이터"),
      h("h2", null, "어느 분기의 생산계획을 맡을까요?"),
      h("p", null, "왼쪽 분기부터 차례로 맡으면 좋습니다. 나중 분기일수록 수주가 많고 판단할 것이 늘어납니다.")),
    h("div", { class: "desk-boards" }, ctx.scenarios.map((sc) => {
      const best = ctx.best[sc.id];
      const mix = Object.entries(sc.ship_mix).map(([name, n]) => `${name} ${n}`).join(" · ");
      const board: HTMLElement = h("button", {
        class: "clipboard desk-board", type: "button",
        "aria-label": `${sc.period} 생산계획, ${sc.name}, 난이도 ${sc.level}`,
        onclick: () => ctx.onPick(sc.id, board),
      },
      h("div", { class: "desk-sheet" },
        h("small", { class: "desk-org" }, "종이배 조선소"),
        h("h3", null, h("span", null, sc.period), "생산계획"),
        h("dl", { class: "desk-fields" },
          h("div", null, h("dt", null, "수주"), h("dd", null, `${sc.ships}척`, h("small", null, ` (${mix})`))),
          h("div", null, h("dt", null, "목표"), h("dd", null, `매출 ${num(sc.kpi.revenue)} · 이익 ${num(sc.kpi.profit)}`)),
          h("div", null, h("dt", null, "기간"), h("dd", null, `작업일 ${sc.days}일`))),
        h("div", { class: "desk-foot" },
          h("span", { class: "desk-level", title: `난이도 ${sc.level} / ${maxLevel}` },
            Array.from({ length: maxLevel }, (_, k) => h("i", { class: k < sc.level ? "on" : "" })),
            h("small", null, LEVEL_NAME[sc.level] ?? `${sc.level}단계`)),
          best
            ? h("span", {
              class: "desk-stamp",
              style: { color: GRADE_TEXT[best.grade] ?? GRADE_EDGE[best.grade] ?? GRADE_COLOR[best.grade], borderColor: GRADE_EDGE[best.grade] ?? GRADE_COLOR[best.grade], background: GRADE_EDGE[best.grade] ? GRADE_COLOR[best.grade] : "transparent" },
              title: `이번 세션 최고 ${best.score.toFixed(1)}점`,
            }, best.grade)
            : null),
        ctx.classCode
          ? h("p", { class: "desk-class" }, `우리 반(${ctx.classCode}) 최고 `,
            ctx.classBest[sc.id]
              ? [h("b", null, `${ctx.classBest[sc.id].grade} ${ctx.classBest[sc.id].score.toFixed(1)}`), ` · ${ctx.classBest[sc.id].nickname}`]
              : "아직 없음")
          : null,
        // 메모: 시나리오 이름은 종이에 붙인 쪽지처럼 둔다.
        h("p", { class: "desk-memo" }, h("b", null, sc.name), " ", sc.summary)));
      return board;
    })));
}
