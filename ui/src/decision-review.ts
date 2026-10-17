// 결정 돌아보기(4.31, D78): 조립 현장 배정 평가서 클립보드의 낱장. 몰리는 날마다 내가 정한 순서와,
// 그날만 다른 순서(규칙 넷)나 기본 대응으로 했다면 어땠을지를 끝까지 돌린 결과를 나란히 둔다.
// 다른 줄은 그날 앞의 내 결정은 그대로, 그날 뒤는 기본 대응이다. 가장 좋은 줄은 인도 → 블록 납기 → 이익 → 직행률 순.
// 화면은 계산하지 않는다: 엔진 결과 review를 표로 옮긴다.

import type { DecisionReview, Result } from "./api";
import { h, num } from "./dom";
import { DISPATCH_INFO } from "./labels";

const CHOICE: Record<string, string> = { mine: "내 순서", auto: "기본 대응(묻지 않음)" };
const label = (c: string) => CHOICE[c] ?? `${DISPATCH_INFO[c]?.name ?? c}이었다면`;

export function renderDecisionReview(result: Result): HTMLElement | null {
  const review = result.review;
  if (!review?.length) return null;
  const wins = review.filter((rv) => rv.mine_is_best).length;
  const allAuto = review[0].rows.find((row) => row.choice === "auto")!;
  const mine = review[0].rows[0];
  return h("div", { class: "review" },
    h("p", { class: "review-lead" },
      `몰리는 날 ${review.length}번 가운데 ${wins}번은 내 순서가 가장 좋았습니다. `,
      `내 결과는 인도 ${mine.on_time}척 · 이익 ${num(mine.profit, 0)}, 처음부터 묻지 않고 기본 대응만 했다면 인도 ${allAuto.on_time}척 · 이익 ${num(allAuto.profit, 0)}입니다(첫 결정의 기본 대응 줄).`),
    review.map((rv) => day(rv, result)),
    h("p", { class: "hint" }, "다른 줄은 그날 앞의 내 결정은 그대로 두고, 그날만 그 순서로, 그 뒤는 조립 공정 계획서의 기본 규칙으로 끝까지 다시 돌린 결과입니다. 가장 좋은 줄은 인도 → 블록 납기 → 이익 → 직행률 순으로 고릅니다."));
}

function day(rv: DecisionReview, result: Result): HTMLElement {
  const mine = rv.rows[0];
  const best = rv.rows.find((row) => row.choice === rv.best)!;
  const mineOrder = Object.values(mine.orders ?? {}).map((ids) => `${ids.slice(0, 4).join(" → ")}${ids.length > 4 ? " …" : ""}`).join(" / ");
  const verdict = rv.mine_is_best
    ? "이날은 내 순서가 가장 좋았습니다."
    : `${label(rv.best).replace("이었다면", "")}이었다면 인도 ${best.on_time}척(지금 ${mine.on_time}척), 블록 납기 ${pct(best.block_rate)}(지금 ${pct(mine.block_rate)}), 이익 ${num(best.profit, 0)}(지금 ${num(mine.profit, 0)}).`;
  const ships = result.ships.map((s) => s.id);
  return h("section", { class: `review-day${rv.mine_is_best ? " is-best" : ""}` },
    h("h3", null, `${rv.day}일 아침`, h("small", null, ` 내 순서: ${mineOrder}`)),
    h("p", { class: "review-verdict" }, verdict),
    h("table", { class: "plan review-table" },
      h("thead", null, h("tr", null, h("th", null, "그날 순서"), h("th", null, "인도 준수"),
        ships.map((id) => h("th", null, `${id} 지연`)), h("th", null, "블록 납기"), h("th", null, "이익"))),
      h("tbody", null, rv.rows.map((row) => h("tr", { class: row.choice === "mine" ? "mine" : row.choice === rv.best && !rv.mine_is_best ? "top" : "" },
        h("th", null, label(row.choice), row.choice === rv.best && !rv.mine_is_best ? h("small", null, " 가장 좋음") : null),
        h("td", null, `${row.on_time}척`),
        ships.map((id) => h("td", { class: row.late[id] ? "late" : "" }, row.late[id] ? `+${row.late[id]}일` : "-")),
        h("td", null, pct(row.block_rate)),
        h("td", null, num(row.profit, 0)))))));
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}
