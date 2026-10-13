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
    // 선미 선실과 연돌(예인선은 가운데 높은 조타실과 굴뚝, 이물에 검은 방현재. 자동차운반선은 선체 위 높은 상자, 앞쪽 위에 선교)
    ...(look.deck === "pctc"
      ? [svgEl("path", { class: "deck", d: `M${cx - L} ${y - 9} L${cx - L} ${y - 30} L${cx + L - 6} ${y - 30} Q${cx + L + 2} ${y - 29} ${cx + L + 2} ${y - 20} L${cx + L + 2} ${y - 9} Z` }),
        svgEl("path", { class: "pipe", d: `M${cx + L - 16} ${y - 26} L${cx + L - 2} ${y - 26}` }),
        svgEl("rect", { class: "funnel", x: cx - L + 6, y: y - 34, width: 4, height: 4 })]
      : tug
      ? [svgEl("rect", { class: "deck", x: cx - 8, y: y - 24, width: 16, height: 15 }),
        svgEl("rect", { class: "funnel", x: cx - 14, y: y - 29, width: 5, height: 8 }),
        svgEl("rect", { class: "fender", x: cx + L - 1, y: y - 7, width: 5, height: 6 })]
      : [svgEl("rect", { class: "deck", x: cx - L + 3, y: y - 20, width: 11, height: 11 }),
        svgEl("rect", { class: "funnel", x: cx - L + 6, y: y - 25, width: 4, height: 5 })]));
  if (look.deck === "container") {
    for (let i = 0; i < (look.size < 1 ? 3 : 4); i++) g.append(svgEl("rect", { class: `box b${i % 3}`, x: cx - L + 18 + i * 13, y: y - 16, width: 12, height: 7 }));
  } else if (look.deck === "moss") {
    for (let i = 0; i < 4; i++) g.append(svgEl("path", { class: "deck", d: `M${cx - L + 16 + i * 15} ${y - 9} a7 7.5 0 0 1 14 0 Z` }));
  } else if (look.deck === "bulk") {
    for (let i = 0; i < 5; i++) g.append(svgEl("rect", { class: "box b2", x: cx - L + 17 + i * 11, y: y - 12, width: 9, height: 3 }));
  } else if (look.deck === "lpg") {
    g.append(svgEl("rect", { class: "deck", x: cx - L + 16, y: y - 12, width: 2 * L - 16, height: 3 }));
    for (let i = 0; i < 3; i++) g.append(svgEl("path", { class: "deck", d: `M${cx - L + 18 + i * 19} ${y - 12} l2 -6 h12 l2 6 Z` }));
  } else if (!tug && look.deck !== "pctc") {
    g.append(svgEl("path", { class: "pipe", d: `M${cx - L + 16} ${y - 11} L${cx + L} ${y - 11}` }));
  }
  return g;
}
