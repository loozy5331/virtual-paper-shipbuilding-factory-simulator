// 클립보드에 꽂은 종이의 머리글. 계획 = 생산계획서, 관제실 = 공정 실적표, 레포트 = 생산실적 평가서.
// 계획 → 실적 → 평가 순서다. 결재란은 작성(Bell) · 승인(Loozy) · 평가.
// 생산계획서는 "승인" 칸이 비어 있고, 펜으로 "Loozy"를 써 넣으면(서명) 실행한다. 평가서는 "평가" 칸에 등급 도장.
// 문서 번호, 기재 항목, 결재란을 가진 서식처럼 보이게 한다. 값은 이미 화면에 있는 것만 옮겨 적는다.

import { h, type Child } from "./dom";

/** 결재란 "작성" 칸에 적는 작성자(사용자 결정). */
export const AUTHOR = "Bell";
/** 결재란 "승인" 칸에 적는 승인자(사용자 결정). */
export const REVIEWER = "Loozy";

export interface DocHead {
  /** 서식 이름. 예: "생산계획서" */
  title: string;
  /** 제목 앞에 작게 붙이는 대상 기간. 예: "2026년 4분기" */
  period?: string;
  /** 문서 번호. 예: "PP-01" */
  code: string;
  /** 기재 항목 [이름, 값]. */
  fields: [string, Child][];
  /** 결재란 "작성" 칸의 이름. 없으면 AUTHOR. */
  author?: string;
  /** 승인을 받았는가. false면 "승인" 칸을 비워 둔다(생산계획서: 펜으로 서명할 자리). 없으면 받은 것으로 본다. */
  approved?: boolean;
  /** "승인" 칸에 적힌 서명자(서명할 때 적은 닉네임). 없으면 REVIEWER. */
  approver?: string;
  /** 결재란 평가 칸에 찍을 도장(생산실적 평가서의 등급). 없으면 빈 칸. */
  stamp?: { text: string; sub: string; color: string; strong?: boolean; fill?: string; ink?: string } | null;
}

export function docHead(doc: DocHead): HTMLElement {
  const sign = (role: string, mark: Child = null) =>
    h("div", { class: "sign" }, h("span", null, role), h("div", { class: "sign-box", "data-sign": role }, mark));
  return h("header", { class: "doc-head" },
    h("div", { class: "doc-title" },
      h("small", null, "종이배 조선소"),
      h("h2", null, doc.period ? h("span", { class: "doc-period" }, doc.period) : null, doc.title),
      h("span", { class: "doc-code" }, `No. ${doc.code}`)),
    h("dl", { class: "doc-fields" },
      doc.fields.map(([name, value]) => h("div", null, h("dt", null, name), h("dd", null, value)))),
    h("div", { class: "approval", "aria-label": "결재란" },
      sign("작성", h("span", { class: "sign-name" }, doc.author ?? AUTHOR)),
      sign("승인", doc.approved === false ? null : h("span", { class: "sign-name" }, doc.approver ?? REVIEWER)),
      sign("평가", doc.stamp
        ? h("span", {
          class: `stamp${doc.stamp.strong ? " strong" : ""}`,
          style: { color: doc.stamp.ink ?? doc.stamp.color, borderColor: doc.stamp.color, ...(doc.stamp.fill ? { background: doc.stamp.fill } : {}) },
        },
          h("b", null, doc.stamp.text), h("small", null, doc.stamp.sub))
        : null)));
}
