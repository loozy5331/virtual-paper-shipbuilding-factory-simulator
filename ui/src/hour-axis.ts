// 시각 축(4.47.2, 사용자 "특근은 같은 사람이 근무시간이 아닌데 더 일하는 것. 같은 날 막대가 줄어드는 것은 병렬 작업처럼 보인다"):
// 블록 막대의 가로축에서 1시간의 폭은 어느 날이든 같다. 하루 칸 = 정규 근무 8시간 + 그날 누군가 정규를 넘겨 일했으면
// 그만큼의 근무시간 외 구간(잔업 2·철야 8시간). 아무도 넘기지 않은 날은 정규 칸만이라 평소에는 예전처럼 촘촘하다.
// 잔업·철야 블록은 같은 날 저녁 구간까지 막대가 길어지고 끝나는 날이 당겨진다. 정규 블록은 저녁 구간에서 끊긴다.
// 화면은 계산하지 않는다(원칙 1): 엔진이 준 시작·끝 시각을 자리로 옮기기만 한다.

/** 정규 근무시간(rules.json hours.day) */
export const REG_HOURS = 8;

/** 블록이 하루 안에서 일한 구간: d일 근무 시작부터 from ~ to시간 */
export interface DayPiece { day: number; from: number; to: number }

/** 날마다 정규를 넘긴 시간(근무시간 외 구간의 길이). 조각들 가운데 그날 가장 늦게 끝난 것 */
export function eveningOf(pieces: Iterable<DayPiece>): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of pieces) {
    const over = p.to - REG_HOURS;
    if (over > 1e-9) out.set(p.day, Math.max(out.get(p.day) ?? 0, over));
  }
  return out;
}

/** 시작(날·시각)부터 끝(날·시각)까지 날마다의 조각. H = 그 블록의 하루 근무시간(잔업 10·철야 16) */
export function dayPieces(start: number, startH: number, end: number, endH: number, H: number): DayPiece[] {
  const out: DayPiece[] = [];
  for (let d = start; d <= end; d++) out.push({ day: d, from: d === start ? startH : 0, to: d === end ? endH : H });
  return out;
}

export interface HourAxis {
  /** 축 전체 길이(시간) */
  total: number;
  /** d일 칸의 왼쪽 끝(축 처음부터 몇 시간). d는 last + 1까지 */
  x(day: number): number;
  /** d일 근무 시작부터 h시간 뒤 */
  at(day: number, h: number): number;
  /** a일부터 b일까지 칸의 폭 */
  width(a: number, b: number): number;
  /** d일의 근무시간 외 구간 길이(없으면 0) */
  evening(day: number): number;
  /** d일 칸에 들어가는 시간(정규 + 근무시간 외) */
  hours(day: number): number;
}

/** first ~ last일 축. 근무시간 외 구간은 evening에 있는 날만 */
export function hourAxis(first: number, last: number, evening: Map<number, number>): HourAxis {
  const ev = (d: number) => (d >= first && d <= last ? evening.get(d) ?? 0 : 0);
  const left: number[] = [0];
  for (let d = first; d <= last; d++) left.push(left[left.length - 1] + REG_HOURS + ev(d));
  const x = (day: number) => {
    if (day <= first) return (day - first) * REG_HOURS;
    if (day > last + 1) return left[left.length - 1] + (day - last - 1) * REG_HOURS;
    return left[day - first];
  };
  return {
    total: left[left.length - 1], x, evening: ev,
    at: (day, h) => x(day) + Math.min(h, REG_HOURS + ev(day)),
    width: (a, b) => x(b + 1) - x(a),
    hours: (d) => REG_HOURS + ev(d),
  };
}
