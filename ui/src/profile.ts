// 배의 옆모습(2D, 4.17에서 main.ts의 시운전 그림을 꺼냄). 선종 코드가 아니라 rules.json의 look으로 그린다(D66).
// 색은 styles.css의 .ship-profile.

import { s as svgEl } from "./dom";
import { lookOf } from "./scene/layout";

/** 배의 옆모습(선종마다 갑판 위가 다르다). 물높이 y에 흘수선이 온다. 시운전 그림과 선박 사양서(4.17)가 함께 쓴다 */
export function shipProfile(type: string, cx: number, y: number): SVGElement {
  const look = lookOf(type);
  const tug = look.deck === "tug";
  const L = tug ? 26 : Math.round(look.length * 29.3);   // 반 길이(px): VLCC 42, LNG선 40, 컨테이너선 38, 피더선 34
  const g = svgEl("g", { class: "ship-profile" },
    // 선체: 위는 종이색, 물에 잠긴 아래는 칠한 색(3D와 같은 붉은 주황)
    svgEl("path", { class: "hull", d: `M${cx - L} ${y - 9} L${cx + L + 6} ${y - 9} L${cx + L - 2} ${y + 3} L${cx - L + 4} ${y + 3} Z` }),
    svgEl("path", { class: "bottom", d: `M${cx - L + 2} ${y} L${cx + L} ${y} L${cx + L - 2} ${y + 3} L${cx - L + 4} ${y + 3} Z` }),
    // 선미 선실과 연돌(예인선은 가운데 높은 조타실과 굴뚝, 이물에 검은 방현재)
    ...(tug
      ? [svgEl("rect", { class: "deck", x: cx - 8, y: y - 24, width: 16, height: 15 }),
        svgEl("rect", { class: "funnel", x: cx - 14, y: y - 29, width: 5, height: 8 }),
        svgEl("rect", { class: "fender", x: cx + L - 1, y: y - 7, width: 5, height: 6 })]
      : [svgEl("rect", { class: "deck", x: cx - L + 3, y: y - 20, width: 11, height: 11 }),
        svgEl("rect", { class: "funnel", x: cx - L + 6, y: y - 25, width: 4, height: 5 })]));
  if (look.deck === "container") {
    for (let i = 0; i < (look.size < 1 ? 3 : 4); i++) g.append(svgEl("rect", { class: `box b${i % 3}`, x: cx - L + 18 + i * 13, y: y - 16, width: 12, height: 7 }));
  } else if (look.deck === "moss") {
    for (let i = 0; i < 4; i++) g.append(svgEl("path", { class: "deck", d: `M${cx - L + 18 + i * 14} ${y - 9} a6 6 0 0 1 12 0 Z` }));
  } else if (!tug) {
    g.append(svgEl("path", { class: "pipe", d: `M${cx - L + 16} ${y - 11} L${cx + L} ${y - 11}` }));
  }
  return g;
}
