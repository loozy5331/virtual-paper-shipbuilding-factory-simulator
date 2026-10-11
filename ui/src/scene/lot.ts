// 로트(배 한 척의 블록 → 배) 3D 모형(4.9.1에 yard.ts에서 나눔): 종이 접힘(FoldMesh), 블록(BlockMesh), 갑판, Lot.
// 단계(form)와 진행률은 frame.ts가 정하고 여기서는 그리기만 한다.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { mesh } from "./people";
import { shipLook } from "./ships";
import { shipSize } from "./layout";
import { clamp01, ease, flatOf, hullTris, type Tri } from "./model";
import { chipHtml, label, PAINT, PAPER, paperMaterial } from "./util";

const UNIT = 0.3;
/** 펼친 종이와 접힌 배 사이를 보간한다(시안과 같은 방법). */
export class FoldMesh {
  readonly mesh: THREE.Mesh;
  private readonly flat: Float32Array;
  private readonly folded: Float32Array;
  private last = -1;

  constructor(tris: Tri[], material: THREE.Material) {
    const flat: number[] = [];
    const folded: number[] = [];
    for (const tri of tris) {
      for (const v of tri.v) {
        folded.push(...v);
        flat.push(...flatOf(v, tri));
      }
    }
    this.flat = new Float32Array(flat);
    this.folded = new Float32Array(folded);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flat), 3));
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.set(0);
  }

  set(t: number): void {
    const e = ease(clamp01(t));
    if (Math.abs(e - this.last) < 1e-3) return;
    this.last = e;
    const attr = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.flat[i] + (this.folded[i] - this.flat[i]) * e;
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

// ---------------------------------------------------------------------------
// 로트: 종이 묶음 → 판 8장(절단) → 굽힌 판(가공) → 블록 8개 → 4개 → 2개 → 배(선종마다 다른 갑판 구조물, ships.ts). D43
// ---------------------------------------------------------------------------

/** 블록 한 개의 길이(x)·높이·폭(z). 4열 × 좌우 2줄 = 8개 */
const BLOCK_X = 0.42, BLOCK_H = 0.22, BLOCK_Z = UNIT;
/** 판(절단·가공 뒤, 소조립 전)의 두께 비율 */
const PLATE = 0.2;

/**
 * 블록 한 개의 모양(D43). 가공에서 판을 굽히면(bend 0 → 1) 선체 곡면이 된다:
 * 바깥쪽 아래가 둥글게 올라가고(빌지), 선미(0열)·선수(3열) 블록은 끝으로 갈수록 가운데 쪽으로 좁아진다. 선수는 바닥도 들린다.
 */
class BlockMesh {
  readonly mesh: THREE.Mesh;
  private readonly flat: Float32Array;
  private readonly curved: Float32Array;
  private bend = -1;

  constructor(col: number, row: number, material: THREE.Material) {
    const geo = new THREE.BoxGeometry(BLOCK_X, BLOCK_H, BLOCK_Z, 4, 2, 3);
    this.flat = Float32Array.from(geo.getAttribute("position").array as Float32Array);
    this.curved = Float32Array.from(this.flat);
    const inward = row === 0 ? 1 : -1;   // 0줄은 왼쪽(−z)이 바깥, 1줄은 오른쪽(+z)이 바깥
    for (let i = 0; i < this.flat.length; i += 3) {
      const x = this.flat[i], y = this.flat[i + 1], z = this.flat[i + 2];
      const out = row === 0 ? 0.5 - z / BLOCK_Z : 0.5 + z / BLOCK_Z;   // 1 = 바깥 가장자리
      const bottom = 0.5 - y / BLOCK_H;                               // 1 = 바닥
      const end = col === 0 ? 0.5 - x / BLOCK_X : col === 3 ? 0.5 + x / BLOCK_X : 0;   // 1 = 배의 끝
      this.curved[i + 1] = y + BLOCK_H * (0.75 * out * out * bottom + (col === 3 ? 0.5 * end * bottom : 0));
      this.curved[i + 2] = z + inward * BLOCK_Z * 0.55 * end * out;
    }
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.setBend(0);
  }

  /** 굽힌 정도 0~1. 바뀔 때만 꼭짓점을 다시 계산한다 */
  setBend(bend: number): void {
    if (Math.abs(bend - this.bend) < 1e-3) return;
    this.bend = bend;
    const attr = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const e = ease(bend);
    for (let i = 0; i < out.length; i++) out[i] = this.flat[i] + (this.curved[i] - this.flat[i]) * e;
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

/** 접힌 선체를 덮는 갑판 종이 한 장 */
export function deckSheet(color?: THREE.Color): THREE.Mesh {
  const shape = new THREE.Shape([[-0.62, 0], [-0.45, 0.38], [0.45, 0.38], [0.7, 0], [0.45, -0.38], [-0.45, -0.38]].map(([x, z]) => new THREE.Vector2(x, z)));
  const deck = new THREE.Mesh(new THREE.ShapeGeometry(shape), paperMaterial(color));
  deck.rotation.x = Math.PI / 2;
  deck.position.y = 0.395;
  deck.receiveShadow = true;
  return deck;
}

export class Lot {
  readonly group = new THREE.Group();
  private readonly units: BlockMesh[] = [];
  private readonly unitMat = paperMaterial();
  private readonly sheet: THREE.Mesh;
  /** 절단 자투리: 절단 정반에서 종이를 자를 때 튀어 나가는 종잇조각(D43, 3.x는 소조립). */
  private readonly scraps: THREE.Mesh[] = [];
  private readonly boat = new THREE.Group();
  private readonly hullMat = paperMaterial();
  private readonly hull = new FoldMesh(hullTris(), this.hullMat);
  /** 접힌 선체를 덮는 갑판(종이 한 장). 다 접힌 뒤에 보인다. */
  private readonly deck: THREE.Mesh;
  /** 선종별 구조물(의장). 탑재 끝에 크레인이 하나씩 올려 붙인다. 마지막이 선실. */
  private readonly parts: THREE.Object3D[];
  private readonly partX: number[];
  private readonly flag = new THREE.Group();
  readonly tag: CSS2DObject;
  /** 크레인 훅이 따라갈 로트 기준 x(로컬). 탑재 중이 아니면 null. */
  hookX: number | null = null;
  hookY = 0;
  /** 훅의 z(로트 기준). 탑재 첫날 PE장 2·3호에서 들어 올 때만 0이 아니다(4.7.5) */
  hookZ = 0;
  readonly target = new THREE.Vector3();
  floatPhase = 0;
  /** 나눠 하는 중이면 부분마다 로트 기준 자리(로컬)와 짝 대기 여부. 블록을 열(짝) 단위로 나눠 그린다. 3.0 */
  split: { offset: THREE.Vector3; waiting: boolean }[] | null = null;
  /** 부분마다 "짝 대기" 칩(2호·3호 부분용 2개 + 1호 부분용 1개) */
  readonly pairTags: CSS2DObject[] = [];
  /** 샛길을 따라가는 중간 지점(작업장 2호·3호로 들고 날 때). 3.0 */
  path: THREE.Vector3[] = [];
  /** 지게차가 들고 있는 중(가공 → 소조립, 4.0.2): 자리는 driveForklifts가 정한다 */
  held = false;
  /** 트랜스포터에 실렸나(그날 운반에서 수레가 실으러 온 뒤). 운반이 아니면 false */
  loaded = false;
  prev: { place: string; station: number; unit: number } | null = null;
  /** 시운전 출항(4.11.2): 출발한 자리(선석·정박지·도크 문 밖). 출항하지 않을 때는 null */
  departFrom: THREE.Vector3 | null = null;
  /** 다 지은 배의 반 길이·반 폭·갑판 높이(야드 단위, 선종 크기를 곱함). 예인줄·계류줄을 거는 자리(4.8.1) */
  readonly dims: { halfLen: number; halfW: number; deck: number };

  constructor(readonly ship: string, kind: string) {
    for (let u = 0; u < 8; u++) {
      const b = new BlockMesh(u % 4, Math.floor(u / 4), this.unitMat);
      this.units.push(b);
      this.group.add(b.mesh);
    }
    this.sheet = mesh(new THREE.BoxGeometry(1.5, 0.06, 1.1), "#f7f3ea");
    this.sheet.position.y = 0.03;
    const scrapGeo = new THREE.CircleGeometry(0.15, 3);
    const scrapMat = paperMaterial(new THREE.Color("#e3d9c3"));
    for (let k = 0; k < 10; k++) {
      const scrap = new THREE.Mesh(scrapGeo, scrapMat);
      scrap.castShadow = true;
      scrap.visible = false;
      this.scraps.push(scrap);
      this.group.add(scrap);
    }
    const stick = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 12), "#6b4a2b");
    stick.position.y = 0.27;
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.32, -0.09), new THREE.Vector2(0, -0.18)]);
    const cloth = mesh(new THREE.ShapeGeometry(shape), "#c0392b", { side: THREE.DoubleSide });
    cloth.position.y = 0.54;
    this.flag.add(stick, cloth);
    const look = shipLook(kind);
    this.flag.position.copy(look.flagAt);
    this.flag.scale.setScalar(0.6);
    this.deck = deckSheet();
    this.parts = look.parts;
    this.partX = this.parts.map((part) => new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3()).x);
    const body = new THREE.Group();
    body.add(this.hull.mesh, this.deck, ...this.parts, this.flag);
    body.scale.set(...look.hull);
    this.boat.add(body);
    this.boat.scale.setScalar(0.85);
    this.tag = label("", "lot-tag");
    this.tag.position.y = 1.0;
    for (let k = 0; k < 3; k++) {
      const t = label(chipHtml("pair_wait", "짝 대기"), "lot-tag");
      t.visible = false;
      this.pairTags.push(t);
      this.group.add(t);
    }
    this.group.add(this.sheet, this.boat, this.tag);
    // 작은 배(예인선·피더선, 4.6)는 블록과 배를 작게(소인국 눈높이로 같은 정반·도크에서 작아 보인다)
    this.group.scale.setScalar(shipSize(kind));
    const k = 0.85 * shipSize(kind);
    this.dims = { halfLen: 1.15 * look.hull[0] * k, halfW: 0.4 * look.hull[2] * k, deck: 0.4 * look.hull[1] * k };
  }

  /** 절단 중이면 자투리가 종이 둘레에서 튀어 나갔다가 떨어진다. time은 초. */
  animateCut(cutting: boolean, time: number): void {
    this.scraps.forEach((scrap, k) => {
      scrap.visible = cutting;
      if (!cutting) return;
      const a = (k / this.scraps.length) * Math.PI * 2 + 0.4;
      const u = (time * 0.9 + k * 0.37) % 1;            // 조각마다 엇갈려 끝없이 반복
      scrap.position.set(Math.cos(a) * (0.6 + u * 1.0), 0.06 + Math.sin(Math.PI * u) * 0.7, Math.sin(a) * (0.5 + u * 0.8));
      scrap.rotation.set(-Math.PI / 2 + u * 4, u * 5 + k, 0);
    });
  }

  /** 칠한 정도 0~1(frame의 paint, 4.0: 도장 공정에서 칠한다) */
  paint = 0;

  /**
   * form: −2 종이 묶음 … 4 배(frame.ts의 FORM). bench면 그 공정이 진행되는 모습:
   * 절단은 묶음이 줄며 판이 한 장씩 나오고, 가공은 판이 굽고, 소조립은 굽힌 판이 하나씩 블록으로 선다.
   */
  setForm(form: number, onBench: boolean, lift: { dx: number; dz: number; k: number } | null = null): void {
    this.hookX = null;
    this.hookZ = 0;
    const stage = Math.floor(form + 1e-9);
    const t = form - stage;
    this.sheet.visible = stage === -2;
    this.sheet.scale.setScalar(stage === -2 && onBench ? 1 - 0.6 * t : 1);
    this.boat.visible = stage >= 3 && (stage === 4 || t > 0);

    // 블록 배치: 4열 × 2줄. 짝(열 2개)이 먼저 붙고(8 → 4), 그다음 좌우 줄이 붙는다(4 → 2). 판일 때는 띄워 놓는다.
    let gp = 0.12, gr = 0.12;
    if (stage === 1) gp = 0.12 * (1 - ease(t));
    if (stage >= 2) gp = 0;
    if (stage === 2) gr = 0.12 * (1 - ease(t));
    if (stage >= 3) gr = 0;
    const gb = 0.22;
    const paint = this.paint;
    this.unitMat.color.lerpColors(PAPER, PAINT, paint);
    this.hullMat.color.copy(PAINT);

    // 절단: 판이 한 장씩 나온다. 그 앞(묶음만)이면 0장
    const visibleUnits = stage === -2 ? (onBench ? Math.ceil(8 * t) : 0) : 8;
    const bend = stage <= -2 ? 0 : stage === -1 ? (onBench ? t : 0) : 1;
    // 탑재(3 → 4): 대블록 2개를 크레인이 하나씩 배 자리로 옮긴다.
    const moving = stage === 3 ? Math.min(1, Math.floor(t * 2)) : -1;
    const u3 = stage === 3 ? t * 2 - moving : 0;
    const pileX = stage === 3 ? -0.8 : 0;
    const boatX = 0.75;

    this.units.forEach((b, u) => {
      const m = b.mesh;
      const c = u % 4, r = Math.floor(u / 4);
      const pair = Math.floor(c / 2), within = c % 2;
      const px = (pair - 0.5) * (2 * BLOCK_X + gb + gp);
      let x = px + (within - 0.5) * (BLOCK_X + gp) + pileX;
      const z = (r - 0.5) * (BLOCK_Z + gr);
      let zLift: number | null = null;
      let y = BLOCK_H / 2;
      let visible = u < visibleUnits && stage < 4;
      if (stage === 3 && lift) {
        // 탑재 첫날 아침(4.7.5): 걸리버 손이 PE장 정반(dx, dz)에서 대블록 둘을 하나씩 도크로 옮긴다.
        // 한 번 오갈 때: 앞 35%는 빈손으로 PE장에 가고, 그다음 블록을 들어 도크 쌓는 자리에 내려놓는다.
        const trip = Math.min(1, Math.floor(lift.k * 2)), kk = lift.k * 2 - trip;
        const atPE = { x: x + lift.dx, z: z + lift.dz };
        if (pair > trip || (pair === trip && kk < 0.35)) { x = atPE.x; zLift = atPE.z; }
        if (pair === trip) {
          if (kk < 0.35) {
            const m = ease(kk / 0.35);
            this.hookX = pileX + (px + lift.dx + pileX - pileX) * m;
            this.hookZ = lift.dz * m;
            this.hookY = 2.2 - (2.2 - BLOCK_H - 0.15) * clamp01((kk - 0.25) / 0.1);
          } else {
            const m = clamp01((kk - 0.35) / 0.55);
            x = atPE.x + (x - atPE.x) * ease(m);
            zLift = atPE.z + (z - atPE.z) * ease(m);
            y = BLOCK_H / 2 + Math.sin(Math.PI * m) * 2.0;
            this.hookX = px + pileX + lift.dx * (1 - ease(m));
            this.hookZ = lift.dz * (1 - ease(m));
            this.hookY = y + BLOCK_H / 2 + 0.15;
          }
        }
      } else if (stage === 3) {
        if (pair < moving) visible = false;
        else if (pair === moving) {
          // 훅에 매달려 이동: 앞 절반은 들어 옮기고, 뒤 절반이면 이미 배에 붙었다.
          const k = clamp01(u3 / 0.55);
          if (u3 > 0.6) visible = false;
          x = x + (boatX - (px + pileX)) * ease(k);
          y = BLOCK_H / 2 + Math.sin(Math.PI * k) * 1.4;
          this.hookX = px + pileX + (boatX - (px + pileX)) * ease(k);
          this.hookY = y + 0.15;
        }
      }
      // 두께: 판(절단·가공 뒤)은 얇고, 소조립에서 판이 하나씩 블록으로 선다
      const thick = stage < 0 ? PLATE : stage === 0 ? PLATE + (1 - PLATE) * (onBench ? clamp01(8 * t - u) : 0) : 1;
      b.setBend(bend);
      m.visible = visible;
      m.scale.set(1, thick, 1);
      m.position.set(x, y * thick, zLift ?? z);
    });

    // 나눠 하기: 블록을 열(짝) 단위로 부분마다 나눠, 부분이 든 작업장 자리로 옮긴다. 탑재(대블록 → 배)는 나누지 않는다.
    const split = this.split;
    this.pairTags.forEach((t, k) => {
      t.visible = !!split && stage < 3 && !!split[k]?.waiting;
      if (split?.[k]) t.position.set(split[k].offset.x, 0.9, split[k].offset.z);
    });
    if (split && split.length > 1 && stage < 3) {
      const k = split.length;
      const partOf = (u: number) => Math.min(k - 1, Math.floor(((u % 4) * k) / 4));
      const sum = Array.from({ length: k }, () => ({ x: 0, n: 0 }));
      this.units.forEach(({ mesh: m }, u) => { const s = sum[partOf(u)]; s.x += m.position.x; s.n += 1; });
      this.units.forEach(({ mesh: m }, u) => {
        const j = partOf(u), mean = sum[j].x / Math.max(1, sum[j].n);
        m.position.x += split[j].offset.x - mean;
        m.position.z += split[j].offset.z;
      });
    }

    if (stage >= 3) {
      // 선체는 블록이 옮겨지는 동안(0~0.75) 접히고, 끝 무렵(0.75~1)에 구조물이 하나씩 올라붙는다. 마지막에 깃발.
      const fold = stage === 4 ? 1 : clamp01(t / 0.75);
      this.hull.set(fold);
      this.deck.visible = fold >= 0.98;
      const n = this.parts.length;
      const outfit = stage === 4 ? n : clamp01((t - 0.75) / 0.22) * n;
      this.parts.forEach((part, k) => {
        const u = clamp01(outfit - k);
        part.visible = u > 0;
        part.position.y = (1 - ease(u)) * 0.6;   // 위에서 내려와 앉는다
        if (stage === 3 && u > 0 && u < 1) {
          this.hookX = boatX + this.partX[k] * 0.85;
          this.hookY = 0.85 + (1 - ease(u)) * 0.5;
        }
      });
      this.flag.visible = stage === 4 || t > 0.97;
      this.boat.position.set(stage === 4 ? 0 : boatX, 0, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// 장면
// ---------------------------------------------------------------------------
