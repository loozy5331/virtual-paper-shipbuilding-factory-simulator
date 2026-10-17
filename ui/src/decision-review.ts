// 결정 돌아보기(4.31, D78): 조립 공정 실습의 조립 공정 실적서의 맨 아래 절(4.35.1, 처음에는 따로 낱장). 몰리는 날마다 내가 정한 순서와,
// 그날만 다른 순서(규칙 넷)나 기본 대응으로 했다면 어땠을지를 끝까지 돌린 결과를 나란히 둔다.
// 다른 줄은 그날 앞의 내 결정은 그대로, 그날 뒤는 기본 대응이다. 가장 좋은 줄은 인도 → 블록 납기 → 이익 → 직행률 순.
// 화면은 계산하지 않는다: 엔진 결과 review를 표로 옮긴다.

import type { DecisionReview, Result } from "./api";
import { h, num } from "./dom";
import { DISPATCH_INFO } from "./labels";

const CHOICE: Record<string, string> = { mine: "내 지시", auto: "기본 대응(묻지 않음)", no_actions: "내 정책, 조치 없이" };
const label = (c: string) => CHOICE[c] ?? `${DISPATCH_INFO[c]?.name ?? c} 정책이었다면`;
const ACTION_NAME: Record<string, string> = { overtime: "잔업", extra: "철야", outsource: "외주", defer: "포기(지체보상금)", assist: "응원 투입", expedite: "긴급 자재 조달" };

export function renderDecisionReview(result: Result): HTMLElement | null {
  const review = result.review;
  if (!review?.length) return null;
  const wins = review.filter((rv) => rv.mine_is_best).length;
  const allAuto = review[0].rows.find((row) => row.choice === "auto")!;
  const mine = review[0].rows[0];
  return h("div", { class: "review" },
    h("p", { class: "review-lead" },
      `몰리는 날 ${review.length}번 가운데 ${wins}번은 내 지시가 가장 좋았습니다. `,
      `내 결과는 인도 ${mine.on_time}척 · 이익 ${num(mine.profit, 0)}, 처음부터 묻지 않고 기본 대응만 했다면 인도 ${allAuto.on_time}척 · 이익 ${num(allAuto.profit, 0)}입니다(첫 결정의 기본 대응 줄).`),
    review.map((rv) => day(rv, result)),
    h("p", { class: "hint" }, "날을 누르면 그날 다른 선택이었다면의 비교 표가 펼쳐집니다. 다른 줄은 그날 앞의 내 결정은 그대로 두고, 그날만 그 정책으로(조치 없이), 그 뒤는 기본 대응으로 끝까지 다시 돌린 결과입니다. \"내 정책, 조치 없이\"는 그날 건 조치(잔업·철야·외주·포기(지체보상금))가 값을 했는지 봅니다. 가장 좋은 줄은 인도 → 블록 납기 → 이익 → 직행률 순으로 고릅니다."));
}

function day(rv: DecisionReview, result: Result): HTMLElement {
  const mine = rv.rows[0];
  const best = rv.rows.find((row) => row.choice === rv.best)!;
  const policy = Object.values(mine.policy).map((r) => DISPATCH_INFO[r]?.name).join(" · ") || "정책 그대로";
  const acts = Object.entries(mine.actions).map(([bid, k]) => `${bid} ${(Array.isArray(k) ? k : [k]).map((x) => ACTION_NAME[x]).join("+")}`).join(", ");
  const mineOrder = `${policy}${acts ? ` · ${acts}` : ""}${mine.spent ? ` (비상 예산 ${num(mine.spent, 0)})` : ""}`;
  const verdict = rv.mine_is_best
    ? "이날은 내 지시가 가장 좋았습니다."
    : `${label(rv.best).replace("이었다면", "")}${rv.best === "auto" || rv.best === "no_actions" ? "였다면" : "이었다면"} 인도 ${best.on_time}척(지금 ${mine.on_time}척), 블록 납기 ${pct(best.block_rate)}(지금 ${pct(mine.block_rate)}), 이익 ${num(best.profit, 0)}(지금 ${num(mine.profit, 0)}).`;
  const ships = result.ships.map((s) => s.id);
  // 4.36.1(사용자 "불필요한 내용은 줄이고"): 날마다 한 줄(그날, 내 지시, 판정)만 보이고 비교 표는 접는다
  return h("details", { class: `review-day${rv.mine_is_best ? " is-best" : ""}` },
    h("summary", null, h("b", null, `${rv.day}일 아침`), h("span", { class: "review-mine" }, ` 내 지시: ${mineOrder}`),
      h("span", { class: "review-verdict" }, ` — ${verdict}`)),
    h("table", { class: "plan review-table" },
      h("thead", null, h("tr", null, h("th", null, "그날 순서"), h("th", null, "인도 준수"),
        ships.map((id) => h("th", null, `${id} 지연`)), h("th", null, "블록 납기"), h("th", null, "비상 예산"), h("th", null, "이익"))),
      h("tbody", null, rv.rows.map((row) => h("tr", { class: row.choice === "mine" ? "mine" : row.choice === rv.best && !rv.mine_is_best ? "top" : "" },
        h("th", null, label(row.choice), row.choice === rv.best && !rv.mine_is_best ? h("small", null, " 가장 좋음") : null),
        h("td", null, `${row.on_time}척`),
        ships.map((id) => h("td", { class: row.late[id] ? "late" : "" }, row.late[id] ? `+${row.late[id]}일` : "-")),
        h("td", null, pct(row.block_rate)),
        h("td", null, row.spent ? num(row.spent, 0) : "-"),
        h("td", null, num(row.profit, 0)))))));
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}
