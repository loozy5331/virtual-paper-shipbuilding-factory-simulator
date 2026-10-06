// 요소를 만드는 작은 도우미와 숫자 형식. 프레임워크 대신 쓴다.
//   h("div", { class: "card", onclick: fn }, "글자", child)
//   s("rect", { x: 0, y: 0, width: 10, height: 10 })   SVG 요소

export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> | null;

const SVG_NS = "http://www.w3.org/2000/svg";

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "style" && typeof value === "object") {
      Object.assign((el as HTMLElement).style, value);
    } else if (!(el instanceof SVGElement) && (key === "value" || key === "checked" || key === "disabled")) {
      // 폼 요소의 현재 값은 속성(attribute)이 아니라 프로퍼티로 넣어야 화면에 반영된다.
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

function appendChildren(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function s(tag: string, attrs: Attrs = null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function mount(root: Element, ...children: Child[]): void {
  root.replaceChildren();
  appendChildren(root, children);
}

// ----- 숫자 형식 -----

export function num(value: number, digits = 1): string {
  return value.toLocaleString("ko-KR", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function money(value: number): string {
  return value.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export function signed(value: number, format: (v: number) => string = num): string {
  if (Math.abs(value) < 1e-9) return "0";
  return value > 0 ? `+${format(value)}` : `−${format(-value)}`;
}
