// 클립보드에 꽂은 종이의 머리글. 계획 = 작업지시서, 관제실 = 공정 실적표, 레포트 = 검사 성적서.
// 문서 번호, 기재 항목, 결재란을 가진 서식처럼 보이게 한다. 값은 이미 화면에 있는 것만 옮겨 적는다.

import { h, type Child } from "./dom";

export interface DocHead {
  /** 서식 이름. 예: "작업지시서" */
  title: string;
  /** 문서 번호. 예: "WO-1" */
  code: string;
  /** 기재 항목 [이름, 값]. */
  fields: [string, Child][];
  /** 결재란 승인 칸에 찍을 도장(검사 성적서의 등급). 없으면 빈 칸. */
  stamp?: { text: string; sub: string; color: string } | null;
}

export function docHead(doc: DocHead): HTMLElement {
  const sign = (role: string, mark: Child = null) =>
    h("div", { class: "sign" }, h("span", null, role), h("div", { class: "sign-box" }, mark));
  return h("header", { class: "doc-head" },
    h("div", { class: "doc-title" },
      h("small", null, "종이배 조선소"),
      h("h2", null, doc.title),
      h("span", { class: "doc-code" }, `No. ${doc.code}`)),
    h("dl", { class: "doc-fields" },
      doc.fields.map(([name, value]) => h("div", null, h("dt", null, name), h("dd", null, value)))),
    h("div", { class: "approval", "aria-label": "결재란" },
      sign("작성"),
      sign("검토"),
      sign("승인", doc.stamp
        ? h("span", { class: "stamp", style: { color: doc.stamp.color, borderColor: doc.stamp.color } },
          h("b", null, doc.stamp.text), h("small", null, doc.stamp.sub))
        : null)));
}
