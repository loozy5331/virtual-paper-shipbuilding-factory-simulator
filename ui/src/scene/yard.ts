// 걸리버의 책상 위 스마트야드. 소인들이 블록을 조립해 종이배를 만든다.
// 현장 화면이 전경과 공정 가까이를 카메라만 바꿔 쓴다.
// 2.1: 현장 전용. 실사에 가깝게(환경광, AO, 사람마다 얼굴과 이름표). 관제실의 작업 현황 전경은 2D(cctv.ts).
// 그리는 내용은 frame.ts의 Frame뿐이다. 이 파일은 규칙을 모른다.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { LEAD_IN, type Delivery, type Frame, type LotView } from "./frame";
import { mesh, Person, SENIOR_NAME, WORKER_NAMES } from "./people";
import { shipLook } from "./ships";
import { STOCK_COLOR_OF, STOCK_STATIONS, stockAssign, stockSpot } from "./stock";
import { buildDock, buildLand, buildRoof, buildSectorOutline, buildWalls, buildYardLines, GiantHand, SEA_Y, type DockParts } from "./coast";
import { areaBounds, benchAt, CART_R, CRANE_R, DEPOT, dockQueueZ, dockZ, LAB, LANE_Z, LOUNGE, MAT_D, MAT_TOP, MAT_W, MAT2_D,
  nearLane, QUEUE_Z, SAFE_SPOT, seaSpot, SECTORS, sectorBounds, SHELF_X, SHELF_Z, SHORE_X, SPUR_IN, SPUR_OUT, SPUR_X, STATION_X,
  STOCK_AT, STOCK_D, STOCK_HALF, STOCK_NAME, CONVEYOR, QUAY_WORK_Z, ST, isShop, quayQueueSpot, along, groundY, kitRoutes, LAB_TREES, LAND_ROUTE, route, SHIP_ROUTE, SUPPLY_DAYS, SUPPLY_EXIT, SUPPLY_ROUTE, unitZ, type Route, type SectorId } from "./layout";
import { clamp01, ease, flatOf, hullTris, type Tri } from "../proto/model";
import { STATE_INFO, STATION_COLOR, STATION_TRADE, TRADE_HAT } from "../labels";
import type { TrackPick } from "../track";

// 배치(야드 좌표)는 layout.ts, 배경은 coast.ts. 증설한 작업장은 1호 뒤로 한 줄씩(2호, 3호, 3.0).
// 구획(3.2, D38): 카메라는 전경 또는 구획 하나(내업, 1도크, 2도크, 안벽). 전경에서는 구획 이름만 보이고, 내업 공장에는 지붕을 덮는다.

// 진수(그림만, 엔진 규칙 없음): 인도 다음 날 하루 안에 ① 작업자가 나가고 ② 도크에 물을 채우고 ③ 걸리버의 손이 문을 열고
// ④ 배가 나가고 ⑤ 문을 닫고 ⑥ 물을 뺀다. 그동안 다음 블록은 도크 앞에서 기다린다. 값은 하루 안의 비율(frac).
const LAUNCH = { fill: [0.1, 0.28], open: [0.28, 0.4], sail: [0.4, 0.62], close: [0.62, 0.74], drain: [0.74, 0.86] } as const;
const LAUNCH_END = 0.86;
const DOOR_OPEN = Math.PI * 0.47;   // 문이 거의 직각으로 열린다

// 현장 안전(3.0, D27·D28·D35): 관리자는 평소 작업장에서 떨어진 안전한 자리에 선다. "골리앗 주변으로"·"트랜스포터 주변으로"를
// 누르면 그 설비 옆으로 순간이동하고, 위험 반경이라 경고한다(재생 중 저절로 뜨는 경고는 1인칭 이동이 생길 때로 미룬다).
// 엔진 규칙이 아니라 현장 화면의 규칙이다. 반경은 팻말에 "반경 10m"로 적는다(소인국 척도라 화면 크기는 보기 좋게만).
// 반경은 layout.ts의 CRANE_R(걸리버의 손, 탑재 도크 둘레)과 CART_R(트랜스포터).
// 안전한 자리(layout.ts의 SAFE_SPOT): 내업과 도크 구획 사이 큰길 앞. 크레인 반경과 큰길 트랜스포터 반경 밖이다.
export type ManagerSpot = "safe" | "crane" | "cart";
export interface Hazard { id: string; label: string }
const WATER_TOP = 0.32;
const phase = (frac: number, [a, b]: readonly [number, number]) => clamp01((frac - a) / (b - a));

const PAPER = new THREE.Color("#f4f0e6");
const PAINT = new THREE.Color("#c8553d");
const BG = new THREE.Color("#dbe5ea");   // 하늘
const UNIT = 0.3;

export type CameraMode = "control" | "field";

export interface DaySource {
  /** 그날 안에서 흐른 비율(0~1)을 받아 장면을 돌려준다. */
  frameAt(frac: number): Frame;
  playing: boolean;
  msPerDay: number;
  /** 걷지 않고 바로 옮긴다: 날짜를 건너뛰었거나 배속이 빠를 때. */
  snap: boolean;
}

function label(html: string, className: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  return new CSS2DObject(div);
}

function setLabel(obj: CSS2DObject, html: string): void {
  if (obj.element.innerHTML !== html) obj.element.innerHTML = html;
}

function paperMaterial(color: THREE.Color = PAPER): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: color.clone(), side: THREE.DoubleSide, flatShading: true, roughness: 0.95 });
}

/** 펼친 종이와 접힌 배 사이를 보간한다(시안과 같은 방법). */
class FoldMesh {
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

class Lot {
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
  readonly target = new THREE.Vector3();
  floatPhase = 0;
  /** 나눠 하는 중이면 부분마다 로트 기준 자리(로컬)와 짝 대기 여부. 블록을 열(짝) 단위로 나눠 그린다. 3.0 */
  split: { offset: THREE.Vector3; waiting: boolean }[] | null = null;
  /** 부분마다 "짝 대기" 칩(2호·3호 부분용 2개 + 1호 부분용 1개) */
  readonly pairTags: CSS2DObject[] = [];
  /** 샛길을 따라가는 중간 지점(작업장 2호·3호로 들고 날 때). 3.0 */
  path: THREE.Vector3[] = [];
  prev: { place: string; station: number; unit: number } | null = null;

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
    const deckShape = new THREE.Shape([[-0.62, 0], [-0.45, 0.38], [0.45, 0.38], [0.7, 0], [0.45, -0.38], [-0.45, -0.38]].map(([x, z]) => new THREE.Vector2(x, z)));
    this.deck = new THREE.Mesh(new THREE.ShapeGeometry(deckShape), paperMaterial());
    this.deck.rotation.x = Math.PI / 2;
    this.deck.position.y = 0.395;
    this.deck.receiveShadow = true;
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
  setForm(form: number, onBench: boolean): void {
    this.hookX = null;
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
      let y = BLOCK_H / 2;
      let visible = u < visibleUnits && stage < 4;
      if (stage === 3) {
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
      m.position.set(x, y * thick, z);
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

export class Yard {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly timer = new THREE.Timer();
  private host: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.resize());
  private running = false;

  private source: DaySource | null = null;
  private sourceAt = 0;
  private lots = new Map<string, Lot>();
  private readonly people: Person[] = [];
  private readonly senior = new Person("senior", 5, SENIOR_NAME);
  private readonly manager = new Person("manager");
  private readonly stationProps: {
    tag: CSS2DObject; smoke: THREE.Group; tape: THREE.Group; candle: THREE.Group; light: THREE.PointLight; flame: THREE.Mesh;
    /** 작업장(1호·2호·3호)마다 정반과 번호 팻말. 2호·3호는 증설했을 때만 보인다 */
    mats: { mat: THREE.Mesh; tag: CSS2DObject }[];
    /** 로봇 팔(인력이 로봇인 공정). 작업장마다 하나 */
    robots: THREE.Group[];
  }[] = [];
  /** 트랜스포터(4.0): T1 자재 키트, T2 블록. crate = T1이 실은 키트 상자 */
  private readonly carts: { group: THREE.Group; tag: CSS2DObject; smoke: THREE.Group; crate: THREE.Mesh }[] = [];
  /** 납품 마차(3.2): 입고일마다 한 대. 사흘 전 등대 곶을 떠나 입고일 아침 창고 뒤에 닿는다(그림만). 여러 대가 함께 길 위에 있을 수 있다 */
  private readonly supply = [0, 1, 2, 3, 4, 5, 6, 7].map(() => buildSupplyCart());
  /** 해상 납품 배(종이 = 철판): 먼바다 → 등대 부두 */
  private readonly ships = [0, 1].map(() => buildSupplyShip());
  private readonly supplyRoute: Route = route(SUPPLY_ROUTE);
  private readonly landRoute: Route = route(LAND_ROUTE);
  private readonly shipRoute: Route = route(SHIP_ROUTE, 1);
  private readonly supplyExit: Route = route(SUPPLY_EXIT);
  private readonly shelves: { boxes: THREE.Mesh[]; tag: CSS2DObject }[] = [];
  /** 자재·블록 추적(3.1): 누르면 상자를 띄울 곳(main.ts), 진하게 볼 배, 선반의 보이지 않는 누름 상자, 추적 중인 배 밑의 고리 */
  private pickHandler: ((pick: TrackPick) => void) | null = null;
  private track: string | null = null;
  private readonly shelfHits: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly trackRing: THREE.Mesh;
  private readonly lounge: CSS2DObject;
  private readonly labTag: CSS2DObject;
  private readonly labWindow: THREE.MeshStandardMaterial;
  /** 관리자 자리와 위험 경고 */
  private managerSpot: ManagerSpot = "safe";
  private managerStation: SectorId | null = null;
  /** 도크마다 크레인 반경 원(1호, 2호) */
  private readonly craneRings: THREE.Mesh[] = [];
  private readonly cartRings: THREE.Mesh[] = [];
  /** 도크마다 크레인이 일하는가(탑재 중이거나 진수 문을 여닫는 중) */
  private craneActive = [false, false];
  /** 탑재 도크 부품(1호·2호·3호): 진수 장면의 문과 물 */
  private readonly docks: DockParts[] = [];
  /** 오늘 적치장에 놓인 블록과 그 자리(stock.ts) */
  private stock: ReturnType<typeof stockAssign> = new Map();
  /** 골리앗 크레인 노릇을 하는 걸리버의 손(하늘에서 수직으로 내려온다). */
  private readonly gulliver = new GiantHand();
  /** 2호 도크의 골리앗 크레인 = 걸리버의 왼손(도크를 증설했을 때만). 도크마다 크레인이 하나씩이다(3.0). */
  private readonly gulliver2 = new GiantHand(true);
  /** 작업장마다의 벽·구획선·도크(2호·3호는 있을 때만 보인다). [공정][작업장 번호 − 1] */
  private readonly areas: THREE.Group[][] = [];
  /** 내업 공장 지붕(작업장마다). 전경과 다른 구획을 볼 때만 보인다 */
  private readonly roofs: THREE.Group[][] = [];
  /** 구획 윤곽과 이름표. 2도크 구획은 도크가 하나면 흐린 "증설 예정지" */
  private readonly sectorMarks = new Map<SectorId, { outline: THREE.Group | null; tag: CSS2DObject }>();
  /** 지금 배치를 맞춘 도크 수(PE장 작업장의 구획이 도크 수에 따라 달라진다) */
  private layoutDocks = 0;
  /** 카메라가 보는 구획. null이면 전경 */
  private focus: SectorId | null = null;
  private readonly camGoal = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private camMoving = 0;

  private readonly hemi = new THREE.HemisphereLight("#fff8ec", "#8a6a4a", 1.5);
  private readonly sun = new THREE.DirectionalLight("#fff1da", 2.6);

  constructor() {
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    this.labels.domElement.className = "scene-labels";

    this.scene.background = BG.clone();
    this.scene.fog = new THREE.Fog(BG.clone(), 70, 170);
    this.aim(null);
    this.camera.position.copy(this.camGoal.pos);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.copy(this.camGoal.target);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 95;
    this.controls.addEventListener("start", () => { this.camMoving = 0; });
    // 누르기: 끌지 않고 떼면(카메라 돌리기와 구분) 그 자리의 블록이나 선반을 찾는다(자재·블록 추적, 3.1)
    let down: { x: number; y: number } | null = null;
    r.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    r.domElement.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pickAt(e.clientX, e.clientY);
      down = null;
    });
    this.trackRing = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.3, 48),
      new THREE.MeshBasicMaterial({ color: "#e0b43a", side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    this.trackRing.rotation.x = -Math.PI / 2;
    this.trackRing.visible = false;
    this.scene.add(this.trackRing);

    const { hemi, sun } = this;
    // 야드가 넓어(구획 넷) 그림자 범위도 넓다. 해상도를 함께 올린다.
    sun.position.set(-15, 22, 14);
    sun.target.position.set(-6, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -48, right: 38, top: 24, bottom: -24, near: 1, far: 90 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(hemi, sun, sun.target);

    buildLand(this.scene);
    this.buildConveyor();
    this.buildAreas();
    this.buildStations();
    this.scene.add(this.gulliver.root);
    const craneTag = label("골리앗 크레인 1호 · 걸리버의 오른손", "place-tag");
    craneTag.position.set(0, 1.5, 0);
    this.gulliver.hand.add(craneTag);
    this.scene.add(this.gulliver2.root);
    const craneTag2 = label("골리앗 크레인 2호 · 걸리버의 왼손", "place-tag");
    craneTag2.position.set(0, 1.5, 0);
    this.gulliver2.hand.add(craneTag2);
    this.gulliver2.root.visible = false;
    this.buildLane();
    this.lounge = this.buildLounge();
    this.buildShelves();
    const lab = this.buildLab();
    this.labTag = lab.tag;
    this.labWindow = lab.window;
    this.buildSectors();
    this.placeStations(1);
    for (const cart of [...this.supply, ...this.ships]) {
      cart.root.visible = false;
      this.scene.add(cart.root);
    }

    // 대기소 사람(4.0: 직종 넷이라 많게는 30명). 보이는 사람은 최대 24명
    for (let i = 0; i < WORKER_NAMES.length; i++) {
      const p = new Person("worker", i, WORKER_NAMES[i]);
      this.people.push(p);
      this.scene.add(p.root);
    }
    this.scene.add(this.senior.root, this.manager.root);
    this.manager.place(this.managerAt(), Math.PI, "stand", true);
    this.buildSafety();
    this.setupLighting();
  }

  // ----- 실사에 가까운 그림 -----
  // 현장은 실사 쪽(환경광 반사, 구석의 그늘 AO, 사람마다 얼굴과 이름표): 직접 와야 진짜가 보인다.
  // 관제실은 3D를 쓰지 않는다(작업 현황 전경은 2D, cctv.ts).

  private composer: EffectComposer | null = null;

  /** 반사는 환경광이 맡고, 고른 빛(반구광)은 줄여 그림자와 명암이 살아나게 한다. */
  private setupLighting(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.35;
    this.hemi.intensity = 0.35;
    this.sun.intensity = 3.2;
    this.renderer.toneMappingExposure = 0.95;
  }

  private render(): void {
    if (!this.composer) {
      const { width, height } = this.renderer.getSize(new THREE.Vector2());
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, width, height);
      ao.updateGtaoMaterial({ radius: 0.5, distanceFallOff: 1, thickness: 1 });
      ao.blendIntensity = 0.8;
      this.composer.addPass(ao);
      this.composer.addPass(new OutputPass());
    }
    this.composer.render();
  }

  /** 현장 이름표를 보일지(가까이 볼 때만). */
  showNameTags(on: boolean): void {
    for (const p of [...this.people, this.senior, this.manager]) p.showTag(on);
  }

  /**
   * 관리자 자리. safe = 도크의 큰길 맞은편(어느 공정을 보든 같은 자리).
   * crane·cart = 그 설비 옆으로 순간이동한다. 위험 반경에 들었으면 무엇인지 돌려준다(화면이 경고).
   */
  setManagerSpot(spot: ManagerSpot, station: SectorId | null): Hazard | null {
    this.managerSpot = spot;
    this.managerStation = station;
    const at = this.managerAt();
    this.manager.place(at, Math.PI, "stand", spot !== "safe", 0.4);
    if (spot === "crane") return { id: "crane", label: "골리앗 크레인(걸리버의 손) 작업 반경" };
    if (spot === "cart") return { id: "cart", label: "트랜스포터 운행 반경" };
    return null;
  }

  private managerAt(): THREE.Vector3 {
    const i = this.managerStation;
    if (this.managerSpot === "crane") return new THREE.Vector3(STATION_X[ST.dock] - 0.8, 0, MAT_D / 2 + 0.6);
    if (this.managerSpot === "cart") {
      // 가장 가까이 있는 트랜스포터 바로 옆(큰길 위)
      const cart = this.carts.find((c) => c.group.visible)?.group.position ?? new THREE.Vector3(DEPOT.x, 0, LANE_Z);
      return new THREE.Vector3(cart.x + 0.5, 0, cart.z + 0.7);
    }
    void i;
    return new THREE.Vector3(SAFE_SPOT.x, 0, SAFE_SPOT.z);
  }

  /** 위험 반경 표시(노랑·검정 점선 원)와 "반경 10m 출입 금지" 팻말 */
  private buildSafety(): void {
    const ring = (r: number) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.07, r, 64),
        new THREE.MeshBasicMaterial({ color: "#e0b43a", transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.03;
      return m;
    };
    // 도크마다 크레인이 하나라 반경도 도크마다(2호는 2호 도크가 있을 때만 보인다)
    for (let u = 0; u < 2; u++) {
      const r = ring(CRANE_R);
      r.position.set(STATION_X[ST.dock], 0.03, dockZ(u));
      r.visible = u === 0;
      this.craneRings.push(r);
      this.scene.add(r);
    }
    for (let k = 0; k < 2; k++) {
      const r = ring(CART_R);
      r.visible = false;
      this.cartRings.push(r);
      this.scene.add(r);
    }
    const sign = label("⚠ 골리앗 크레인 반경 10m 출입 금지", "place-tag small warn-tag");
    sign.position.set(STATION_X[ST.dock] - CRANE_R + 0.3, 0.05, 2.6);
    this.scene.add(sign);
  }

  /** 위험 반경 원: 크레인은 일할 때 진하게, 트랜스포터는 움직일 때 따라다닌다. */
  private drawHazardRings(): void {
    this.craneRings.forEach((r, u) => { (r.material as THREE.MeshBasicMaterial).opacity = this.craneActive[u] ? 0.9 : 0.3; });
    this.carts.forEach((cart, k) => {
      const ring = this.cartRings[k];
      if (!ring) return;
      ring.visible = cart.group.visible && cart.group.userData.moving === true;
      ring.position.set(cart.group.position.x, 0.03, cart.group.position.z);
    });
  }

  /** 생산관리자 소인의 이름표: 서명한 닉네임. */
  setManagerName(name: string): void {
    this.manager.setName(name);
  }

  // ----- 구성 -----

  /** 공정마다 작업장 셋(1호·2호·3호)의 정반, 이름표, 고장 연기, 사고 테이프, 잔업 촛불, 로봇 팔. 자리는 placeStations가 정한다. */
  private buildStations(): void {
    STATION_X.forEach((_, i) => {
      const ids = Object.keys(STATION_COLOR);
      const color = STATION_COLOR[ids[i]];
      const mats = [0, 1, 2].map((u) => {
        const m = mesh(new THREE.BoxGeometry(MAT_W, MAT_TOP, u === 0 ? MAT_D : MAT2_D), color, { roughness: 0.95 });
        m.castShadow = false;
        m.visible = u === 0;
        this.scene.add(m);
        const t = label(`${u + 1}호`, "place-tag small");
        t.visible = false;
        this.scene.add(t);
        return { mat: m, tag: t };
      });
      const tag = label("", "station-tag");
      this.scene.add(tag);

      // 고장: 연기 / 사고: 통제 테이프
      const smoke = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const puff = mesh(new THREE.SphereGeometry(0.22, 20, 14), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.visible = false;
      this.scene.add(smoke);

      const tape = new THREE.Group();
      const hw = MAT_W / 2 + 0.35, hd = MAT_D / 2 + 0.35;
      const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      corners.forEach(([cx, cz], k) => {
        const post = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 16), "#2b2b2b");
        post.position.set(cx, 0.3, cz);
        tape.add(post);
        const [nx, nz] = corners[(k + 1) % 4];
        const len = Math.hypot(nx - cx, nz - cz);
        const band = mesh(new THREE.BoxGeometry(len, 0.08, 0.02), "#f2c230", { emissive: "#3a2d00" });
        band.position.set((cx + nx) / 2, 0.5, (cz + nz) / 2);
        band.rotation.y = -Math.atan2(nz - cz, nx - cx);
        tape.add(band);
      });
      tape.visible = false;
      this.scene.add(tape);

      // 잔업: 촛불
      const candle = new THREE.Group();
      const wax = mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.5, 24), "#f3e6c8");
      wax.position.y = 0.25;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 8), new THREE.MeshBasicMaterial({ color: "#ffb347" }));
      flame.position.y = 0.6;
      const light = new THREE.PointLight("#ffae5a", 0, 7, 1.3);
      light.position.y = 0.75;
      candle.add(wax, flame, light);
      this.scene.add(candle);

      const robots = [0, 1, 2].map(() => {
        const robot = buildRobot();
        robot.visible = false;
        this.scene.add(robot);
        return robot;
      });

      this.stationProps.push({ tag, smoke, tape, candle, light, flame, mats, robots });
    });
  }

  /** 작업장마다: 소조립·중조립은 벽만 있는 공장(앞은 열림) + 지붕, PE장은 바깥 정반(노란 구획선), 탑재는 드라이 도크. 그리고 물류창고 구역과 적치장. */
  private buildAreas(): void {
    STATION_X.forEach((_, p) => {
      this.areas[p] = [];
      this.roofs[p] = [];
    });
    // 물류창고: 뒷벽에 문(납품 마차가 뒤에서 상자를 내린다)
    this.scene.add(buildWalls(SHELF_X[0] - 1.5, SHELF_X[2] + 1.5, SHELF_Z - 0.9, SHELF_Z + 1.0, 1.9, { x: SHELF_X[1], w: 1.3 }));

    // 적치장: 공정(탑재 제외)마다 칸. 기다리는 블록은 정반 대신 여기에 둔다(내업 두 공정은 큰길 건너편, PE장은 1도크 구획).
    STOCK_AT.slice(0, STOCK_STATIONS).forEach((at, p) => {
      const far = at.z0 + at.dir * STOCK_D;
      const z0 = Math.min(at.z0, far), z1 = Math.max(at.z0, far);
      const floor = mesh(new THREE.BoxGeometry(STOCK_HALF * 2, 0.02, STOCK_D), "#b7b2a6", { roughness: 1 });
      floor.position.set(at.x, 0.011, (z0 + z1) / 2);
      floor.castShadow = false;
      this.scene.add(floor, buildYardLines(at.x - STOCK_HALF, at.x + STOCK_HALF, z0, z1, "#f4f1ea"));
      const ids = Object.keys(STATION_COLOR);
      const tag = label(`<i style="background:${STATION_COLOR[ids[STOCK_COLOR_OF[p]]]}"></i>${STOCK_NAME[p]}`, "station-tag small-tag");
      tag.position.set(at.x - STOCK_HALF + 0.9, 0.05, far - at.dir * 0.25);
      this.scene.add(tag);
    });
  }

  /**
   * 도크 수에 맞춰 작업장 자리를 놓는다(PE장 작업장은 도크가 둘이면 2·3호가 2도크 구획으로 간다).
   * 벽·구획선·도크·지붕은 다시 만들고, 정반·팻말·로봇은 옮긴다. 도크 수가 바뀔 때만 부른다.
   */
  private placeStations(docks: number): void {
    this.layoutDocks = docks;
    STATION_X.forEach((_, p) => {
      for (const g of [...this.areas[p], ...this.roofs[p]]) if (g) this.scene.remove(g);
      this.areas[p] = [];
      this.roofs[p] = [];
      const props = this.stationProps[p];
      for (const unit of [0, 1, 2]) {
        const { x0, x1, z0, z1 } = areaBounds(p, unit, docks);
        // 안벽의장·시운전은 물 위라 구역 그림이 없다(빈 묶음)
        const area = isShop(p) ? buildWalls(x0, x1, z0, z1, 1.0)
          : p === ST.pe ? buildYardLines(x0, x1, z0, z1)
          : p === ST.quay ? buildYardLines(x0, x1, z0, z1)   // 안벽 위 작업 구역
          : p > ST.dock ? new THREE.Group()
          : buildDock(x0, x1, z0, z1);
        area.visible = unit === 0;
        this.scene.add(area);
        this.areas[p][unit] = area;
        if (p === ST.dock) this.docks[unit] = area.userData.dock as DockParts;
        if (isShop(p)) {
          const roof = buildRoof(x0, x1, z0, z1, 1.0);
          roof.visible = false;
          this.scene.add(roof);
          this.roofs[p][unit] = roof;
        }
        const b = benchAt(p, unit, docks);
        props.mats[unit].mat.position.set(b.x, MAT_TOP / 2, b.z);
        props.mats[unit].tag.position.set(b.x - MAT_W / 2 - 0.2, 0.1, b.z);
        props.robots[unit].position.set(b.x + MAT_W / 2 + 0.25, 0, b.z);
      }
      const first = benchAt(p, 0, docks);
      props.tag.position.set(first.x, 0.1, first.z - first.d / 2 - 0.45);
      props.candle.position.set(first.x + MAT_W / 2 + 0.3, 0, first.z - 1.2);
    });
    // 구획 윤곽과 이름표도 도크 수에 맞춘다(2도크 구획은 도크가 하나면 흐린 "증설 예정지")
    for (const base of SECTORS) {
      const sec = sectorBounds(base.id, docks);
      const mark = this.sectorMarks.get(sec.id);
      if (!mark) continue;
      if (mark.outline) this.scene.remove(mark.outline);
      mark.outline = sec.id === "quay" ? null : buildSectorOutline(sec, sec.id === "dock2" && docks < 2);
      if (mark.outline) this.scene.add(mark.outline);
      // 이름은 구획의 왼쪽 가장자리(작업장 이름표와 겹치지 않게): 1도크는 뒤, 나머지는 앞
      mark.tag.position.set(sec.x0 + 2.4, 0.05, sec.id === "dock1" ? sec.z0 + 0.4 : sec.z1 - 0.4);
      if (sec.id === "dock2") setLabel(mark.tag, docks >= 2 ? "2도크 구획" : "2도크 구획 · 증설 예정지");
    }
    if (this.focus) this.setCamera("field", this.focus);
  }

  /** 구획 이름표. 전경에서는 이것만 글로 보인다. 윤곽(바닥의 점선)과 자리는 placeStations가 도크 수에 맞춰 놓는다. */
  private buildSectors(): void {
    for (const sec of SECTORS) {
      const tag = label(sec.name, "sector-tag");
      this.scene.add(tag);
      this.sectorMarks.set(sec.id, { outline: null, tag });
    }
  }

  private buildLane(): void {
    const lane = mesh(new THREE.BoxGeometry(SHORE_X - 0.3 - (DEPOT.x - 1.5), 0.02, 1.0), "#9f9a8f", { roughness: 1 });
    lane.position.set((DEPOT.x - 1.5 + SHORE_X - 0.3) / 2, 0.01, LANE_Z);
    lane.castShadow = false;
    this.scene.add(lane);
    // 샛길: 큰길에서 공정 사이로 3호 작업장 뒤까지 들어간다(뒤쪽 작업장에 블록을 나르는 길).
    // PE장 양옆 샛길은 큰길 앞(2도크 구획의 3호)으로도 이어진다.
    const spur = (x: number, z0: number, z1: number) => {
      const m = mesh(new THREE.BoxGeometry(0.8, 0.02, z1 - z0), "#9f9a8f", { roughness: 1 });
      m.position.set(x, 0.012, (z0 + z1) / 2);
      m.castShadow = false;
      this.scene.add(m);
    };
    SPUR_X.forEach((sx, k) => {
      spur(sx, unitZ(2) - MAT2_D / 2 - 0.4, LANE_Z - 0.5);
      if (k >= 4) spur(sx, LANE_Z + 0.5, benchAt(ST.pe, 2, 2).z + MAT2_D / 2 + 0.4);
    });
    for (let k = 0; k < 2; k++) {
      const group = new THREE.Group();
      const deck = mesh(new THREE.BoxGeometry(1.7, 0.2, 1.0), "#5d6b78", { metalness: 0.2 });
      deck.position.y = 0.22;
      const cab = mesh(new THREE.BoxGeometry(0.35, 0.3, 0.9), "#d6a400");
      cab.position.set(-0.95, 0.3, 0);
      group.add(deck, cab);
      for (const wx of [-0.6, 0.6]) {
        for (const wz of [-0.42, 0.42]) {
          const wheel = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 24), "#222");
          wheel.rotation.x = Math.PI / 2;
          wheel.position.set(wx, 0.12, wz);
          group.add(wheel);
        }
      }
      const smoke = new THREE.Group();
      for (let s = 0; s < 4; s++) {
        const puff = mesh(new THREE.SphereGeometry(0.16, 16, 12), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.visible = false;
      group.add(smoke);
      const tag = label(`T${k + 1}`, "place-tag small");
      tag.position.y = 0.9;
      group.add(tag);
      // 자재 키트 상자(T1이 싣고 다닐 때만 보인다)
      const crate = mesh(new THREE.BoxGeometry(0.6, 0.35, 0.5), "#c9a26b");
      crate.position.y = 0.5;
      crate.visible = false;
      group.add(crate);
      group.position.set(DEPOT.x, 0, LANE_Z + k * 1.15);
      group.visible = false;
      this.scene.add(group);
      this.carts.push({ group, tag, smoke, crate });
    }
  }

  private buildLounge(): CSS2DObject {
    const floor = mesh(new THREE.BoxGeometry(4.2, 0.03, 3.0), "#d9d2c3", { roughness: 1 });
    floor.position.set(LOUNGE.x, 0.015, LOUNGE.z);
    floor.castShadow = false;
    this.scene.add(floor);
    for (const row of [0, 1]) {
      const bench = mesh(new THREE.BoxGeometry(3.4, 0.12, 0.4), "#9c7b55");
      bench.position.set(LOUNGE.x, 0.3, LOUNGE.z - 0.6 + row * 1.2);
      this.scene.add(bench);
    }
    const tag = label("", "place-tag");
    tag.position.set(LOUNGE.x, 1.3, LOUNGE.z - 1.2);
    this.scene.add(tag);
    return tag;
  }

  private loungeSeat(i: number): THREE.Vector3 {
    const row = Math.floor(i / 4), col = i % 4;
    return new THREE.Vector3(LOUNGE.x - 1.2 + col * 0.8, 0.2, LOUNGE.z - 0.6 + row * 1.2);
  }

  private buildShelves(): void {
    const colors = ["#f7f3ea", "#c8553d", "#c0392b"];
    SHELF_X.forEach((x, i) => {
      for (const sx of [-1, 1]) {
        const side = mesh(new THREE.BoxGeometry(0.08, 1.6, 0.9), "#8a6a4a");
        side.position.set(x + sx * 1.0, 0.8, SHELF_Z);
        this.scene.add(side);
      }
      for (const y of [0.05, 0.6, 1.15]) {
        const board = mesh(new THREE.BoxGeometry(2.0, 0.05, 0.9), "#a07e58");
        board.position.set(x, y, SHELF_Z);
        this.scene.add(board);
      }
      // 상자 24개: 선반 3단 × 4개 = 12개까지, 넘치면 바닥(앞)에 쌓는다 → 재고 과다
      const boxes: THREE.Mesh[] = [];
      for (let k = 0; k < 24; k++) {
        const box = mesh(new THREE.BoxGeometry(0.36, 0.32, 0.5), "#c9a26b");
        const top = mesh(new THREE.BoxGeometry(0.3, 0.02, 0.44), colors[i]);
        top.position.y = 0.17;
        box.add(top);
        if (k < 12) {
          const level = Math.floor(k / 4), slot = k % 4;
          box.position.set(x - 0.66 + slot * 0.44, 0.24 + level * 0.55, SHELF_Z);
        } else {
          const j = k - 12, slot = j % 4, level = Math.floor(j / 4);
          box.position.set(x - 0.66 + slot * 0.44, 0.16 + level * 0.33, SHELF_Z + 0.9);
        }
        box.visible = false;
        this.scene.add(box);
        boxes.push(box);
      }
      // 누름 상자: 선반 전체(보이지 않게). 선반을 누르면 자재 페깅 상자
      const hit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 1.9), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      hit.position.set(x, 0.9, SHELF_Z + 0.45);
      hit.userData.shelf = i;
      this.scene.add(hit);
      this.shelfHits.push(hit);
      const tag = label("", "shelf-tag");
      tag.position.set(x, 1.75, SHELF_Z + 0.2);
      tag.element.classList.add("pickable");
      tag.element.addEventListener("click", () => {
        const material = this.source?.frameAt(1).shelves[i]?.material;
        if (material) this.pickHandler?.({ kind: "material", material });
      });
      this.scene.add(tag);
      this.shelves.push({ boxes, tag });
    });
    const sign = label("물류창고 구역", "place-tag");
    sign.position.set(SHELF_X[1], 2.6, SHELF_Z - 0.9);
    this.scene.add(sign);
  }

  private buildLab(): { tag: CSS2DObject; window: THREE.MeshStandardMaterial } {
    const body = mesh(new THREE.BoxGeometry(3.0, 1.6, 2.0), "#eef2f4");
    body.position.set(LAB.x, 0.8, LAB.z);
    const roof = mesh(new THREE.ConeGeometry(2.0, 0.8, 4), "#5d7a8c");
    roof.position.set(LAB.x, 2.0, LAB.z);
    roof.rotation.y = Math.PI / 4;
    const window = new THREE.MeshStandardMaterial({ color: "#3a4a58", emissive: "#000000" });
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6), window);
    pane.position.set(LAB.x, 0.95, LAB.z + 1.01);
    // 출입구(큰길 쪽)에서 보이는 창도 하나 더
    const pane2 = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6), window);
    pane2.position.set(LAB.x, 0.95, LAB.z - 1.01);
    pane2.rotation.y = Math.PI;
    this.scene.add(body, roof, pane, pane2);
    // 보안(3.2): 둘레에 침엽수를 촘촘히 심어 가린다. 큰길 쪽 가운데만 출입구로 비운다(layout.ts의 LAB_TREES)
    const leaf = new THREE.MeshStandardMaterial({ color: "#3f6b47", roughness: 0.9, flatShading: true });
    const bark = new THREE.MeshStandardMaterial({ color: "#6b4a2b", roughness: 1 });
    LAB_TREES.forEach((t, k) => {
      const tree = new THREE.Group();
      const h = 1.5 + (k % 3) * 0.2;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.4, 8), bark);
      trunk.position.y = 0.2;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.5, h, 10), leaf);
      crown.position.y = 0.35 + h / 2;
      for (const m of [trunk, crown]) { m.castShadow = true; m.receiveShadow = true; }
      tree.add(trunk, crown);
      tree.position.set(t.x, 0, t.z);
      this.scene.add(tree);
    });
    const tag = label("", "place-tag");
    tag.position.set(LAB.x, 2.8, LAB.z);
    this.scene.add(tag);
    return { tag, window };
  }

  // ----- 연결 -----

  /** 캔버스를 다른 패널로 옮긴다(관제실 ↔ 현장). */
  attach(host: HTMLElement): void {
    if (this.host === host) return;
    if (this.host) this.resizeObserver.unobserve(this.host);
    this.host = host;
    host.append(this.renderer.domElement, this.labels.domElement);
    this.resizeObserver.observe(host);
    this.resize();
  }

  /** 새 결과. 배 로트를 다시 만든다. */
  load(ships: { id: string; type: string }[]): void {
    for (const lot of this.lots.values()) {
      this.scene.remove(lot.group);
      // CSS2D 라벨은 부모를 지워도 DOM에 남는다. 직접 뗀다.
      lot.tag.element.remove();
      lot.pairTags.forEach((t) => t.element.remove());
    }
    this.lots.clear();
    ships.forEach(({ id, type }, i) => {
      const lot = new Lot(id, type);
      lot.floatPhase = i * 1.7;
      lot.group.userData.pick = { kind: "ship", ship: id } satisfies TrackPick;
      // 이름표(S3 칩)도 누를 수 있다(라벨 층은 원래 누름을 통과시킨다)
      lot.tag.element.classList.add("pickable");
      lot.tag.element.addEventListener("click", () => this.pickHandler?.({ kind: "ship", ship: id }));
      lot.group.visible = false;
      this.lots.set(id, lot);
      this.scene.add(lot.group);
    });
  }

  /** 블록이나 선반을 누르면 부를 함수(자재·블록 추적 상자) */
  setPickHandler(fn: (pick: TrackPick) => void): void {
    this.pickHandler = fn;
  }

  /** 추적 중인 배: 그 배 블록 밑에 노란 고리, 이름표를 진하게(나머지는 흐리게), 선반에 그 배 몫 */
  setTrack(ship: string | null): void {
    this.track = ship;
  }

  private pickAt(clientX: number, clientY: number): void {
    if (!this.pickHandler) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [...[...this.lots.values()].filter((l) => l.group.visible).map((l) => l.group), ...this.shelfHits];
    for (const hit of this.raycaster.intersectObjects(targets, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (o.userData.pick) return this.pickHandler(o.userData.pick as TrackPick);
        if (o.userData.shelf !== undefined) {
          const material = this.source?.frameAt(1).shelves[o.userData.shelf as number]?.material;
          if (material) return this.pickHandler({ kind: "material", material });
          return;
        }
      }
    }
  }

  setSource(source: DaySource): void {
    this.source = source;
    this.sourceAt = performance.now();
    this.draw(source.snap);
  }

  /** 카메라: 전경(null) 또는 구획 하나. 전경에서는 구획 이름만 보이고 공장에 지붕을 덮는다. */
  setCamera(mode: CameraMode, focus: SectorId | null = null): void {
    this.aim(mode === "control" ? null : focus);
    this.camMoving = 1;
  }

  private aim(focus: SectorId | null): void {
    this.focus = focus;
    this.labels.domElement.classList.toggle("overview", focus === null);
    if (focus === null) {
      // 전경: 높이서 비스듬히. 구획 넷과 큰길, 만 입구의 등대가 함께 들어오게.
      this.camGoal.target.set(-6, 0, 1);
      this.camGoal.pos.set(-6, 40, 42);
      return;
    }
    // 구획 하나를 화면 가득: 구획이 클수록 멀리서, 뒷줄 작업장까지 벽 너머로 보이게 높이 내려다본다.
    const sec = sectorBounds(focus, Math.max(1, this.layoutDocks));
    const w = sec.x1 - sec.x0, d = sec.z1 - sec.z0;
    const span = Math.max(w * 0.8, d * 1.25, 9);
    const cx = (sec.x0 + sec.x1) / 2, cz = (sec.z0 + sec.z1) / 2;
    this.camGoal.target.set(cx, 0, cz - d * 0.05);
    this.camGoal.pos.set(cx + span * 0.08, span * 0.95, cz + span * 0.85);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    const loop = (now: number) => {
      if (!this.running) return;
      this.timer.update(now);
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  // ----- 매 프레임 -----

  private resize(): void {
    if (!this.host) return;
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    this.draw(false);
    for (const p of [...this.people, this.senior, this.manager]) p.update(dt);
    this.drawHazardRings();
    for (const lot of this.lots.values()) {
      if (!lot.group.visible) continue;
      // 대기 줄 → 정반처럼 자리를 옮기는 로트도 준비 시간(1배속 0.15초) 안에 닿게 빨리 옮긴다.
      const goal = lot.path[0] ?? lot.target;
      lot.group.position.lerp(goal, Math.min(1, dt * 22));
      if (lot.path.length && lot.group.position.distanceTo(goal) < 0.15) lot.path.shift();
    }
    this.animateProps(t);
    // 추적: 그 배 블록 밑에 고리, 이름표는 그 배만 진하게
    const tracked = this.track ? this.lots.get(this.track) : undefined;
    this.trackRing.visible = !!tracked?.group.visible;
    if (tracked) this.trackRing.position.set(tracked.group.position.x, Math.max(0.05, tracked.group.position.y) + 0.03, tracked.group.position.z);
    for (const lot of this.lots.values()) {
      lot.tag.element.classList.toggle("tracked", this.track === lot.ship);
      lot.tag.element.classList.toggle("untracked", this.track !== null && this.track !== lot.ship);
    }
    if (this.camMoving > 0) {
      const k = Math.min(1, dt * 3);
      this.camera.position.lerp(this.camGoal.pos, k);
      this.controls.target.lerp(this.camGoal.target, k);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.05) this.camMoving = 0;
    }
    this.controls.update();
    this.render();
    this.labels.render(this.scene, this.camera);
  }

  private draw(snap: boolean): void {
    const src = this.source;
    if (!src) return;
    const frac = src.playing ? clamp01((performance.now() - this.sourceAt) / src.msPerDay) : 1;
    const f = src.frameAt(frac);
    const jump = snap || src.snap;
    // 사람은 하루의 준비 시간 안에 새 자리에 도착한다(작업은 그 뒤에 진행, frame.ts의 LEAD_IN).
    const within = (src.msPerDay / 1000) * LEAD_IN;

    // 도크 수가 바뀌면(다른 회차) PE장 작업장 자리를 다시 놓는다.
    const docks = f.stations[ST.dock]?.units.length ?? 1;
    if (docks !== this.layoutDocks) this.placeStations(docks);
    // 로트. 기다리는 블록의 적치장 자리를 먼저 정한다.
    this.stock = stockAssign(f);
    let hook: { x: number; y: number } | null = null;
    let hook2: { x: number; y: number } | null = null;   // 2호 도크(왼손)
    // 진수: 재생 중 하루 안의 비율로 단계를 나눈다(멈춰 있으면 frac = 1이라 다 끝난 모습).
    const launching = src.playing && frac < LAUNCH_END ? f.launches : [];
    this.drawLaunchDocks(launching, frac);
    for (const view of f.lots) {
      const lot = this.lots.get(view.ship);
      if (!lot) continue;
      // 인도한 배(sea)는 선주에게 넘어가 조선소를 떠났다(화면 오른쪽 위 인도 완료 로그에 남는다)
      // 인도한 배는 떠났고, 시운전 중인 배는 먼바다에 나가 있다(화면 오른쪽 아래 말풍선)
      lot.group.visible = view.place !== "hidden" && view.place !== "sea" && !(view.place === "bench" && view.station === ST.trial);
      if (!lot.group.visible) continue;
      const launch = launching.find((l) => l.ship === view.ship);
      if (launch) {
        // 진수하는 배: 도크에서 물에 뜨고, 문으로 나가 바다 자리로
        lot.setForm(4, false);
        lot.group.rotation.set(0, 0, 0);
        lot.group.position.copy(this.launchPosition(launch.unit, frac, this.lotPosition(view, frac, f)));
        lot.target.copy(lot.group.position);
        lot.prev = null;
        setLabel(lot.tag, this.lotLabel(view));
        continue;
      }
      // 진수가 끝날 때까지 다음 블록은 도크 앞에서 기다린다
      const held = view.place === "bench" && view.station === ST.dock && launching.some((l) => l.unit === view.unit);
      const pos = held ? new THREE.Vector3(STATION_X[ST.dock] - 0.9, 0, dockQueueZ(view.unit)) : this.lotPosition(view, frac, f);
      lot.target.copy(pos);
      this.planPath(lot, view, jump, docks);
      if (jump || view.place === "carried" || view.place === "sea") lot.group.position.copy(pos);
      // 나눠 하기: 부분마다 자기 작업장 자리. 먼저 끝난 부분은 공용 적치장으로 나가 짝을 기다린다.
      if (view.place === "bench" && view.parts && view.parts.length > 1) {
        lot.split = view.parts.map((pt) => {
          // 먼저 끝난 부분은 공용 적치장 칸에서 짝을 기다린다(작업장은 비워 둔다).
          const waiting = pt.state === "pair_wait";
          const spot = waiting ? this.stock.get(`w:${view.ship}:${pt.unit}`) : undefined;
          const at = spot ? stockSpot(spot.station, spot.index) : null;
          const b = benchAt(view.station, pt.unit, docks);
          const world = at ? new THREE.Vector3(at.x, 0, at.z) : new THREE.Vector3(b.x, MAT_TOP, b.z);
          return { offset: world.sub(pos), waiting };
        });
      } else {
        lot.split = null;
      }
      lot.paint = view.paint;
      lot.setForm(view.form, view.place === "bench");
      lot.animateCut(view.place === "bench" && view.station === ST.cut && (view.state === "work" || view.state === "rework"), performance.now() / 1000);
      if (view.place === "sea") {
        lot.group.rotation.set(Math.sin(lot.floatPhase * 1.1) * 0.03, 0, Math.sin(lot.floatPhase * 1.3) * 0.04);
      } else {
        lot.group.rotation.set(0, 0, 0);
      }
      // 골리앗 크레인 훅은 1호 탑재 정반의 블록을 따라간다(2호는 같은 크레인 아래 안쪽 자리).
      if (!held && view.place === "bench" && view.station === ST.dock && lot.hookX !== null) {
        if (view.unit === 0) hook = { x: lot.hookX, y: lot.hookY };
        else if (view.unit === 1) hook2 = { x: lot.hookX, y: lot.hookY };
      }
      setLabel(lot.tag, this.lotLabel(view));
      lot.tag.position.y = view.form >= 3 ? 1.9 : 1.0;
    }

    // 골리앗 크레인(걸리버의 손): 탑재 중이면 자석판이 블록을 따라간다. 쉴 때는 도크 위에 손을 띄워 둔다.
    // 도크마다 손이 하나: 1호 = 오른손, 2호 = 왼손(2호가 있을 때만). 진수 중이면 그 도크의 손이 문을 열고 닫는다.
    const hands: [GiantHand, { x: number; y: number } | null, number][] = [[this.gulliver, hook, 0], [this.gulliver2, hook2, 1]];
    for (const [hand, hk, u] of hands) {
      this.craneRings[u].visible = u < docks;
      if (u >= docks) { hand.root.visible = false; continue; }
      hand.root.visible = true;
      const at = new THREE.Vector3(STATION_X[ST.dock] + (hk ? hk.x : 0), hk ? hk.y + 0.15 : 3.0, dockZ(u));
      const launch = launching.find((l) => l.unit === u);
      const gate = launch ? this.gateHand(u, frac) : null;
      hand.place(gate ? at.lerp(gate.at, gate.k) : at);
    }
    // 컨베이어벨트: 가공이 일하는 날 판이 흘러간다
    const proc = f.stations[ST.proc];
    this.beltOn = !!proc && (proc.state === "work" || proc.state === "rework");
    this.craneActive = [0, 1].map((u) => (u === 0 ? hook : hook2) !== null || launching.some((l) => l.unit === u));

    // 정반: 작업장(1호, 증설하면 2호)마다 인원 또는 로봇, 시니어, 중지, 잔업
    let person = 0;
    // 내업 지붕은 전경이나 다른 구획을 볼 때만(내업을 가까이 보면 지붕과 철골을 통째로 숨긴다, D38)
    const roofsOn = this.focus !== "shop";
    f.stations.forEach((st, i) => {
      const props = this.stationProps[i];
      const working = st.state === "work" || st.state === "rework";
      const robot = st.crew === "robot";
      const bench = (u: number) => benchAt(i, u, docks);
      props.mats.forEach((e, u) => {
        const on = u < st.units.length;
        e.mat.visible = on && i <= ST.dock;   // 안벽의장·시운전은 물 위(정반 없음)
        e.tag.visible = on && st.units.length > 1 && u > 0;
        if (this.areas[i][u]) this.areas[i][u].visible = on;
        if (this.roofs[i][u]) this.roofs[i][u].visible = on && roofsOn;
      });
      props.robots.forEach((r, u) => {
        r.visible = robot && u < st.units.length;
        r.userData.working = robot && (st.units[u]?.state === "work" || st.units[u]?.state === "rework");
      });
      if (!robot && i !== ST.trial) {   // 시운전 외부팀은 배와 함께 먼바다에 있다
        st.units.forEach((unit, u) => {
          const unitWorking = unit.state === "work" || unit.state === "rework";
          // 진수하는 도크의 작업자는 도크 밖(앞쪽)으로 비켜 선다
          const out = i === ST.dock && launching.some((l) => l.unit === u);
          const b = bench(u);
          for (let k = 0; k < unit.workers; k++) {
            const side = k % 2 === 0 ? 1 : -1;
            // 안벽의장 작업자는 배 옆 안벽 위에 선다
            const at = out ? new THREE.Vector3(b.x - 2.6 - k * 0.6, 0, b.z + (b.z <= LANE_Z ? 1.9 : -1.9))
              : i === ST.quay ? new THREE.Vector3(b.x - 0.9 * side, 0, QUAY_WORK_Z + (k >> 1) * 0.7)
              : new THREE.Vector3(b.x - 0.9 * side, MAT_TOP, b.z + side * 1.0);
            const p = this.people[person++];
            p?.setHat(TRADE_HAT[STATION_TRADE[st.id]] ?? TRADE_HAT.assembly);
            p?.place(at, side > 0 ? Math.PI : 0, unitWorking && !out ? "work" : "stand", jump, within);
            p?.holdKnife(i === ST.cut && unitWorking);
          }
        });
      }
      if (st.senior) {
        this.senior.setVisible(true);
        const out = i === ST.dock && launching.length > 0;
        const b = bench(0);
        this.senior.place(out ? new THREE.Vector3(b.x - 1.6, 0, b.z + 1.9) : new THREE.Vector3(b.x + 1.3, MAT_TOP, b.z - 0.2),
          -Math.PI / 2, working && !out ? "work" : "stand", jump, within);
        this.senior.holdKnife(i === ST.cut && working);
      }
      // 멈춘 작업장에 연기(고장)나 통제 테이프(사고). 둘 다 멈췄으면 1호에 표시한다.
      const stopped = st.units.findIndex((u) => u.stop !== null);
      const stop = stopped >= 0 ? st.units[stopped].stop : null;
      props.smoke.visible = stop === "breakdown";
      props.tape.visible = stop === "accident";
      const sb = bench(Math.max(0, stopped));
      props.smoke.position.set(sb.x + 1.1, 0.4, sb.z - 0.9);
      props.tape.position.set(sb.x, 0, sb.z);
      props.light.intensity = st.overtime ? 5 : 0;
      props.flame.visible = st.overtime;
      const chip = st.stop === "accident" ? chipHtml("accident_stop", "사고 · 통제")
        : st.stop === "breakdown" ? chipHtml("breakdown_stop", "고장 · 수리 중")
        : st.state === "labor_wait" ? chipHtml("labor_wait", "인력 대기")
        : st.state === "material_wait" ? chipHtml("material_wait", "자재 대기")
        : i === ST.cut && working ? `<span class="chip cut">절단 중</span>`
        : i === ST.proc && working ? `<span class="chip cut">굽힘 중</span>` : "";
      const crewNote = robot ? " · 로봇" : st.crew === "skilled" ? " · 숙련공" : "";
      props.tag.visible = i !== ST.trial;
      setLabel(props.tag, `<i style="background:${STATION_COLOR[st.id]}"></i>${st.name}${st.units.length > 1 ? " 1호" : ""}${crewNote}${st.overtime && !robot ? " · 잔업" : ""}${chip}`);
    });
    if (!f.stations.some((st) => st.senior)) this.senior.setVisible(false);

    // 작업대기소: 오늘 배정되지 않은 사람은 앉아서 기다린다(인원 과다가 보인다).
    // 직종마다 모자 색으로(4.0, D42)
    let seat = 0;
    for (const [trade, n] of Object.entries(f.idleByTrade)) {
      for (let k = 0; k < n && person < this.people.length; k++) {
        this.people[person].holdKnife(false);
        this.people[person].setHat(TRADE_HAT[trade] ?? TRADE_HAT.assembly);
        this.people[person++].place(this.loungeSeat(seat++), 0, "sit", jump, within);
      }
    }
    const used = person;
    this.people.forEach((p, i) => p.setVisible(i < used));
    setLabel(this.lounge, `작업대기소 · 쉬는 사람 <b>${f.idleWorkers}</b>명`);

    // 트랜스포터
    f.transporters.forEach((tr, k) => {
      const cart = this.carts[k];
      cart.group.visible = true;
      const lot = tr.role === "block" && tr.ship ? f.lots.find((l) => l.ship === tr.ship) : undefined;
      let at: THREE.Vector3;
      let carrying = false;
      if (tr.role === "material" && tr.state === "move" && tr.kitTo !== null) {
        // T1: 준비 시간 안에 물류창고 앞으로 가 키트를 싣고(~0.4), 그 공정 앞으로(~0.8). 멈춰 있으면 공정 앞.
        const r = kitRoutes(tr.kitTo);
        const t = src.playing ? frac : 1;
        const p = t < LEAD_IN ? along(r.pick, t / LEAD_IN) : t < 0.4 ? along(r.pick, 1) : along(r.drop, Math.min(1, (t - 0.4) / 0.4));
        at = new THREE.Vector3(p.x, 0, p.z);
        carrying = t >= 0.4 && t < 0.95;
      } else if (tr.state === "move" && lot) {
        at = lot.place === "carried"
          ? this.lotPosition(lot, frac, f).setY(0)
          : new THREE.Vector3(STATION_X[lot.station] - 1.4, 0, LANE_Z);
      } else if (tr.state === "breakdown_stop") {
        at = cart.group.position.clone();
      } else {
        at = new THREE.Vector3(DEPOT.x, 0, LANE_Z + k * 1.15);
      }
      cart.group.position.lerp(at, jump ? 1 : 0.2);
      cart.group.userData.moving = tr.state === "move";
      // 운반 중인 로트는 트랜스포터가 실으러 온 뒤에야 함께 움직인다(수레보다 앞서 가지 않게).
      // 수레가 아직 멀면 로트는 실을 자리에서 기다린다.
      if (tr.state === "move" && lot?.place === "carried") {
        const lotObj = this.lots.get(lot.ship);
        if (lotObj && cart.group.position.distanceTo(at) < 0.8) lotObj.group.position.copy(cart.group.position).setY(0.32);
      }
      cart.smoke.visible = tr.state === "breakdown_stop";
      cart.crate.visible = carrying;
      const name = `${tr.id} ${tr.role === "material" ? "자재" : "블록"}`;
      setLabel(cart.tag, tr.state === "breakdown_stop" ? `${name} ${chipHtml("breakdown_stop", "고장")}` : name);
    });
    for (let k = f.transporters.length; k < this.carts.length; k++) this.carts[k].group.visible = false;

    // 자재창고: 선반이 비면 "입고 D-n" 팻말
    f.shelves.forEach((sh, i) => {
      const shelf = this.shelves[i];
      const shown = Math.min(sh.qty, shelf.boxes.length);
      shelf.boxes.forEach((b, k) => { b.visible = k < shown; });
      const note = sh.qty > 0 ? `<b>${sh.qty}</b>` : sh.nextArrival ? chipHtml("material_wait", `입고 D-${sh.nextArrival - f.day}`) : "<b>0</b>";
      const mine = this.track ? sh.pegs.find((pg) => pg.ship === this.track)?.quantity ?? 0 : null;
      setLabel(shelf.tag, `${sh.name} ${note}${mine !== null ? `<br><small class="${mine ? "track" : ""}">${this.track} 몫 ${mine}</small>` : ""}`);
    });

    this.drawSupply(f, src.playing, frac);

    // 연구소
    const rs = f.research;
    this.labWindow.emissive.set(rs.current ? "#7fd1ff" : "#000000");
    this.labWindow.emissiveIntensity = rs.current ? 0.8 : 0;
    const now = rs.current ? `${rs.current.name} ${rs.current.done}/${rs.current.total}일` : "진행 중인 연구 없음";
    const done = rs.finished.length ? `<br><small>완료: ${rs.finished.join(", ")}</small>` : "";
    setLabel(this.labTag, `연구소 · ${now}${done}`);
  }

  /**
   * 납품 마차: 입고일 d의 마차는 d − 3일 아침 등대 곶을 떠나 납품 길을 사흘 동안 달려 d일 아침 창고 뒤에 닿는다.
   * d일에는 상자를 내리고(0~0.3, 준비 시간 안) 왼쪽 길로 야드를 빠져나간다(~0.75). 멈춰 있으면 그날 끝(frac = 1) 자리.
   * 입고일 마차는 멈춰 있으면 창고 뒤에 선 채로, 무엇이 몇 개 들어왔는지 이름표를 단다. 길 위 마차는 "입고 D-n"만.
   */
  private drawSupply(f: Frame, playing: boolean, frac: number): void {
    // 해상(종이): d−3일에 배가 먼바다에서 부두로(그날 안에 닿음), d−2일 아침(0~0.3) 마차에 옮겨 싣고 배는 돌아간다.
    //   마차는 d−2일 0.3부터 d−1일 끝까지 해상 길을 달린다. 육로(물감·깃발): 마차가 d−3~d−1일 산길을 달린다.
    // d일에는 창고 뒤에서 상자를 내리고(0~0.3) 왼쪽 길로 나간다(~0.75). 멈춰 있으면 그날 끝(frac = 1) 자리.
    const t = playing ? frac : 1;
    let ship = 0;
    for (const s of this.ships) s.root.visible = false;
    this.supply.forEach((cart, k) => {
      const dv = f.deliveries[k];
      const left = dv ? dv.day - f.day : 0;   // 입고까지 남은 날
      const today = !!dv && left === 0;
      let at: { x: number; z: number; angle: number } | null = null, unloaded = 0;
      if (dv && today) {
        if (t < 0.3) { at = along(this.supplyExit, 0); unloaded = playing ? Math.min(1, t / 0.25) : 1; }
        else if (t < 0.75 || !playing) { at = along(this.supplyExit, playing ? ease((t - 0.3) / 0.45) : 0); unloaded = 1; }
      } else if (dv && dv.route === "land") {
        at = along(this.landRoute, (SUPPLY_DAYS - left + t) / SUPPLY_DAYS);
      } else if (dv) {
        // 해상: 배와 부두, 그다음 마차
        const shipObj = this.ships[ship++];
        if (left === 3 || (left === 2 && t < 0.3)) {
          const u = left === 3 ? t : 1;
          if (shipObj) this.placeShip(shipObj, along(this.shipRoute, u), dv, f, left === 3 ? 1 : 1 - t / 0.3);
        } else if (left === 2 && shipObj && playing) {
          // 짐을 넘기고 먼바다로 돌아간다
          this.placeShip(shipObj, along(this.shipRoute, 1 - ease((t - 0.3) / 0.7)), dv, f, 0, true);
        }
        if (left <= 2) {
          const u = left === 2 ? Math.max(0, (t - 0.3) / 1.7) : (0.7 + t) / 1.7;
          at = along(this.supplyRoute, u);
          // 배에서 마차로 옮겨 싣는 중(상자가 하나씩 생긴다)
          unloaded = left === 2 && t < 0.3 ? 1 - Math.min(1, t / 0.25) : 0;
        }
      }
      cart.root.visible = !!at;
      if (!dv || !at) return;
      cart.root.position.set(at.x, groundY(at.x, at.z), at.z);
      cart.root.rotation.y = -at.angle;
      cart.crates.forEach((c, i) => {
        const a = dv.items[i];
        c.visible = !!a && i >= Math.floor(unloaded * dv.items.length + 1e-9);
        if (a) (c.userData.top as THREE.Mesh).material = crateTop(f.shelves.findIndex((sh) => sh.material === a.material));
      });
      setLabel(cart.tag, today ? `입고 · ${dv.items.map((a) => `${a.name} <b>${a.quantity}</b>`).join(" · ")}` : `입고 D-${left} · ${dv.route === "sea" ? "해상" : "육로"}`);
    });
  }

  /** 납품 배: 물길 위 자리, 실은 상자(cargo 0~1 비율만큼), 돌아가면 뱃머리를 돌린다 */
  private placeShip(ship: SupplyShip, at: { x: number; z: number; angle: number }, dv: Delivery, f: Frame, cargo: number, back = false): void {
    ship.root.visible = true;
    ship.root.position.set(at.x, SEA_Y, at.z);
    ship.root.rotation.y = -at.angle + (back ? Math.PI : 0);   // 뱃머리(+x)가 나아가는 쪽, 돌아갈 때는 반대
    ship.crates.forEach((c, i) => { c.visible = i < Math.ceil(cargo * 3) && cargo > 0; });
    setLabel(ship.tag, `입고 D-${dv.day - f.day} · ${dv.items.map((a) => `${a.name} ${a.quantity}`).join(" · ")}`);
  }

  /**
   * 샛길: 2호·3호 작업장으로 들어갈 때는 공정 왼쪽 샛길로, 나올 때는 오른쪽 샛길로 돌아간다(벽을 뚫고 지나가지 않게).
   * 로트의 자리(place·공정·작업장)가 바뀐 순간에만 경로를 정한다. 날짜를 건너뛰면(jump) 바로 옮긴다.
   */
  private planPath(lot: Lot, view: LotView, jump: boolean, docks: number): void {
    const now = { place: view.place, station: view.station, unit: view.unit };
    const before = lot.prev;
    lot.prev = now;
    if (jump || !before) { lot.path = []; return; }
    if (before.place === now.place && before.station === now.station && before.unit === now.unit) return;
    const y = MAT_TOP;
    const to = benchAt(now.station, now.unit, docks), from = benchAt(before.station, before.unit, docks);
    if (before.station === ST.proc && before.place === "bench" && now.station === ST.sub) {
      // 가공 → 소조립: 컨베이어벨트 위로 올라 벨트를 따라 간다(D43)
      const c = CONVEYOR;
      lot.path = [new THREE.Vector3(c.x0 - 0.3, c.y, c.z), new THREE.Vector3(c.x1 + 0.3, c.y, c.z)];
      return;
    }
    if (now.place === "bench" && !nearLane(to.z) && before.place !== "bench") {
      const sx = SPUR_X[SPUR_IN[now.station]];
      lot.path = [new THREE.Vector3(sx, y, LANE_Z), new THREE.Vector3(sx, y, to.z)];
    } else if (before.place === "bench" && !nearLane(from.z) && now.place !== "bench") {
      const sx = SPUR_X[SPUR_OUT[before.station]];
      lot.path = [new THREE.Vector3(sx, y, from.z), new THREE.Vector3(sx, y, LANE_Z)];
    } else {
      lot.path = [];
    }
  }

  /** 진수 중인 도크의 물 높이와 문 각도. 진수가 없는 도크는 마른 채 닫힌다. */
  private drawLaunchDocks(launching: { ship: string; unit: number }[], frac: number): void {
    this.docks.forEach((dock, u) => {
      if (!dock) return;
      const on = launching.some((l) => l.unit === u);
      const level = on ? phase(frac, LAUNCH.fill) * (1 - phase(frac, LAUNCH.drain)) : 0;
      dock.water.visible = level > 0.01;
      dock.water.scale.y = Math.max(0.01, level * WATER_TOP);
      dock.water.position.y = (level * WATER_TOP) / 2;
      const open = on ? phase(frac, [LAUNCH.open[0] + 0.05, LAUNCH.open[1]]) * (1 - phase(frac, [LAUNCH.close[0], LAUNCH.close[1] - 0.05])) : 0;
      dock.hinge.rotation.y = ease(open) * DOOR_OPEN;   // 오른쪽 끝이 바다 쪽으로 밀려 열린다(현관문)
    });
  }

  /** 걸리버의 손이 문으로 가는 정도(k)와 문 바깥 자리. 열 때와 닫을 때만 문에 붙는다. */
  private gateHand(unit: number, frac: number): { at: THREE.Vector3; k: number } | null {
    const dock = this.docks[unit];
    if (!dock) return null;
    const go = phase(frac, [LAUNCH.fill[1] - 0.06, LAUNCH.open[0] + 0.04]);
    const back = phase(frac, [LAUNCH.close[1] - 0.02, LAUNCH.close[1] + 0.08]);
    const k = ease(go) * (1 - ease(back));
    const open = ease(phase(frac, [LAUNCH.open[0] + 0.05, LAUNCH.open[1]]) * (1 - phase(frac, [LAUNCH.close[0], LAUNCH.close[1] - 0.05]))) * DOOR_OPEN;
    // 문짝의 오른쪽(경첩 반대) 끝을 손바닥 자석판이 잡고 바다 쪽으로 돌려 연다. 열린 문은 배 왼쪽으로 비켜 있다.
    const len = dock.zHalf * 2 - 0.3;
    const at = new THREE.Vector3(dock.x1 + 0.25 + Math.sin(open) * len, 0.62, dock.zc - dock.zHalf + Math.cos(open) * len);
    return k > 0.001 ? { at, k } : null;
  }

  /** 진수하는 배의 자리: 도크 바닥 → 물에 떠오름 → 문 밖 → 바다의 제자리. */
  private launchPosition(unit: number, frac: number, sea: THREE.Vector3): THREE.Vector3 {
    const dock = this.docks[unit];
    const cx = STATION_X[ST.dock], z = dockZ(unit);
    const float = phase(frac, LAUNCH.fill) * WATER_TOP;
    const t = phase(frac, LAUNCH.sail);
    const inDock = new THREE.Vector3(cx, MAT_TOP + float, z);
    const gate = new THREE.Vector3((dock?.x1 ?? cx + 2) + 1.0, SEA_Y + 0.02, z);
    if (t <= 0) return inDock;
    if (t < 0.45) return inDock.lerp(gate, ease(t / 0.45));
    return gate.lerp(sea, ease((t - 0.45) / 0.55));
  }

  private lotPosition(view: LotView, frac: number, f: Frame): THREE.Vector3 {
    const x = STATION_X[view.station];
    switch (view.place) {
      case "bench": {
        const b = benchAt(view.station, view.unit, this.layoutDocks);
        // 안벽의장·시운전: 배는 물 위
        return new THREE.Vector3(b.x, view.station >= ST.quay ? SEA_Y + 0.02 : MAT_TOP, b.z);
      }
      case "queue":
      case "outbound": {
        // 공용 적치장 칸(탑재 앞 대기는 예외: 도크 앞)
        const spot = this.stock.get(`${view.place === "queue" ? "q" : "o"}:${view.ship}`);
        if (spot) {
          const at = stockSpot(spot.station, spot.index);
          return new THREE.Vector3(at.x, 0, at.z);
        }
        if (view.station >= ST.quay) {
          const q = quayQueueSpot(view.slot);
          return new THREE.Vector3(q.x, SEA_Y + 0.02, q.z);
        }
        return new THREE.Vector3(x - 0.9 - view.slot * 1.9, 0, QUEUE_Z);
      }
      case "carried": {
        const from = x + 1.2, to = STATION_X[view.station + 1] - 0.9;
        return new THREE.Vector3(from + (to - from) * ease(view.travel ?? frac), 0.32, LANE_Z);
      }
      case "sea": {
        const lot = this.lots.get(view.ship)!;
        lot.floatPhase += 0.016;
        const i = f.lots.filter((l) => l.place === "sea").indexOf(view);
        // 안벽 앞 바다에 세 척씩 두 줄로 띄운다.
        const at = seaSpot(i);
        return new THREE.Vector3(at.x, SEA_Y + 0.02 + Math.sin(lot.floatPhase * 1.6) * 0.03, at.z);
      }
      default: return new THREE.Vector3(DEPOT.x, -5, 0);
    }
  }

  private lotLabel(view: LotView): string {
    const chip = view.state === "rework" ? chipHtml("rework", "재작업")
      : view.place === "bench" && view.state === "work" ? ""
      : view.place === "sea" ? (view.late ? `<span class="chip late">지연 인도</span>` : "")
      : STATE_INFO[view.state] ? chipHtml(view.state, STATE_INFO[view.state].name) : "";
    return `<b>${view.ship}</b>${chip}`;
  }

  /** 컨베이어벨트 위 판(가공이 일하는 동안 벨트를 따라 흘러간다) */
  private readonly beltPlates: THREE.Mesh[] = [];
  private beltOn = false;

  /** 컨베이어벨트(D43): 가공 공장에서 소조립 공장까지. 샛길 위를 지나도록 다리 위에 놓는다 */
  private buildConveyor(): void {
    const c = CONVEYOR, len = c.x1 - c.x0 + 1.2, cx = (c.x0 + c.x1) / 2;
    const belt = mesh(new THREE.BoxGeometry(len, 0.08, c.w), "#3a3f3c", { roughness: 0.9 });
    belt.position.set(cx, c.y, c.z);
    const rails = [-1, 1].map((side) => {
      const r = mesh(new THREE.BoxGeometry(len, 0.12, 0.05), "#9aa3a8");
      r.position.set(cx, c.y + 0.04, c.z + side * (c.w / 2 + 0.02));
      return r;
    });
    this.scene.add(belt, ...rails);
    for (const x of [c.x0 - 0.4, cx, c.x1 + 0.4]) for (const side of [-1, 1]) {
      const leg = mesh(new THREE.BoxGeometry(0.06, c.y, 0.06), "#7d878c");
      leg.position.set(x, c.y / 2, c.z + side * c.w / 2);
      this.scene.add(leg);
    }
    for (let k = 0; k < 4; k++) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.26), paperMaterial());
      plate.castShadow = true;
      plate.visible = false;
      this.beltPlates.push(plate);
      this.scene.add(plate);
    }
  }

  private animateProps(t: number): void {
    const c = CONVEYOR;
    this.beltPlates.forEach((plate, k) => {
      plate.visible = this.beltOn;
      if (!this.beltOn) return;
      const u = (t * 0.25 + k / this.beltPlates.length) % 1;
      plate.position.set(c.x0 - 0.5 + (c.x1 - c.x0 + 1) * u, c.y + 0.06, c.z);
    });
    const puffs = (g: THREE.Group, height: number) => {
      if (!g.visible) return;
      g.children.forEach((c, k) => {
        const u = (t * 0.6 + k / g.children.length) % 1;
        c.position.set(Math.sin(k * 2.1 + t) * 0.15, u * height, Math.cos(k * 1.7) * 0.15);
        c.scale.setScalar(0.6 + u * 1.2);
        ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0.6 * (1 - u);
      });
    };
    this.stationProps.forEach((p, i) => {
      puffs(p.smoke, 2.2);
      p.flame.scale.set(1, 1 + Math.sin(t * 13) * 0.12, 1);
      // 로봇 팔: 일하는 동안 정반 위로 팔을 뻗었다 접는다.
      p.robots.forEach((r, u) => {
        if (!r.visible) return;
        const arm = r.userData.arm as THREE.Object3D;
        const fore = r.userData.fore as THREE.Object3D;
        const w = r.userData.working ? 1 : 0;
        arm.rotation.y = Math.PI + Math.sin(t * 2.2 + i + u) * 0.6 * w;
        fore.rotation.z = -0.9 + Math.sin(t * 3.1 + u) * 0.35 * w;
      });
    });
    this.carts.forEach((c) => puffs(c.smoke, 1.4));
  }
}

const CRATE_COLORS = ["#f7f3ea", "#c8553d", "#c0392b"];   // 선반 상자 뚜껑과 같은 색(종이, 물감, 깃발)
const crateTops = CRATE_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c }));
const crateTop = (i: number) => crateTops[i] ?? crateTops[0];

interface SupplyShip { root: THREE.Group; crates: THREE.Mesh[]; tag: CSS2DObject }

/** 해상 납품 배: 낮은 화물선(선체, 선미 조타실), 갑판에 철판(종이) 묶음 셋. 앞이 +x */
function buildSupplyShip(): SupplyShip {
  const root = new THREE.Group();
  const hull = mesh(new THREE.BoxGeometry(3.2, 0.5, 1.1), "#3f4f5a", { roughness: 0.7 });
  hull.position.y = 0.25;
  const bow = mesh(new THREE.ConeGeometry(0.55, 0.9, 4), "#3f4f5a", { roughness: 0.7 });
  bow.rotation.set(0, Math.PI / 4, -Math.PI / 2);
  bow.scale.set(1, 1, 0.7);
  bow.position.set(2.0, 0.25, 0);
  const cabin = mesh(new THREE.BoxGeometry(0.7, 0.6, 0.8), "#e9e4d8");
  cabin.position.set(-1.2, 0.8, 0);
  root.add(hull, bow, cabin);
  const crates = [0, 1, 2].map((k) => {
    const c = mesh(new THREE.BoxGeometry(0.6, 0.18, 0.7), "#f7f3ea");
    c.position.set(-0.3 + k * 0.7, 0.6, 0);
    root.add(c);
    return c;
  });
  const tag = label("", "place-tag small");
  tag.position.set(0, 1.6, 0);
  root.add(tag);
  return { root, crates, tag };
}

/** 납품 마차: 말 한 마리와 짐수레, 자재 상자 셋. 무광 단색(장식은 절제). 앞이 +x */
function buildSupplyCart(): { root: THREE.Group; crates: THREE.Mesh[]; tag: CSS2DObject } {
  const root = new THREE.Group();
  const horse = new THREE.Group();
  const coat = "#8a5a3b";
  const body = mesh(new THREE.BoxGeometry(0.9, 0.34, 0.3), coat);
  body.position.y = 0.58;
  const neck = mesh(new THREE.BoxGeometry(0.2, 0.42, 0.18), coat);
  neck.position.set(0.48, 0.78, 0);
  neck.rotation.z = -0.5;
  const head = mesh(new THREE.BoxGeometry(0.34, 0.16, 0.16), coat);
  head.position.set(0.66, 0.96, 0);
  const mane = mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), "#3b2a1e");
  mane.position.set(0.42, 0.84, 0);
  mane.rotation.z = -0.5;
  const tail = mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), "#3b2a1e");
  tail.position.set(-0.48, 0.5, 0);
  tail.rotation.z = 0.4;
  horse.add(body, neck, head, mane, tail);
  for (const lx of [-0.34, 0.34]) for (const lz of [-0.1, 0.1]) {
    const leg = mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.42, 8), coat);
    leg.position.set(lx, 0.21, lz);
    horse.add(leg);
  }
  horse.position.x = 0.75;
  const bed = mesh(new THREE.BoxGeometry(1.1, 0.08, 0.7), "#a07e58");
  bed.position.set(-0.55, 0.36, 0);
  root.add(horse, bed);
  for (const sz of [-1, 1]) {
    const board = mesh(new THREE.BoxGeometry(1.1, 0.14, 0.04), "#8a6a4a");
    board.position.set(-0.55, 0.46, sz * 0.33);
    const wheel = mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 20), "#4a3a2c");
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(-0.55, 0.26, sz * 0.4);
    const shaft = mesh(new THREE.BoxGeometry(0.9, 0.04, 0.04), "#6b4a2b");
    shaft.position.set(0.3, 0.45, sz * 0.2);
    root.add(board, wheel, shaft);
  }
  const crates = [0, 1, 2].map((k) => {
    const box = mesh(new THREE.BoxGeometry(0.28, 0.26, 0.5), "#c9a26b");
    box.position.set(-0.9 + k * 0.33, 0.53, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.44), crateTop(k));
    top.position.y = 0.14;
    box.add(top);
    box.userData.top = top;
    root.add(box);
    return box;
  });
  const tag = label("", "place-tag small");
  tag.position.set(-0.2, 1.3, 0);
  root.add(tag);
  return { root, crates, tag };
}

/** 로봇 팔: 받침, 돌아가는 기둥, 위팔, 아래팔, 집게. 무광 회색(장식은 절제). */
function buildRobot(): THREE.Group {
  const robot = new THREE.Group();
  const base = mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.22, 32), "#7c858a");
  base.position.y = 0.11;
  const arm = new THREE.Group();                    // 기둥 위에서 좌우로 돈다
  arm.position.y = 0.22;
  const post = mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.9, 24), "#9aa3a8");
  post.position.y = 0.45;
  const fore = new THREE.Group();                   // 어깨에서 정반 쪽으로 뻗는다
  fore.position.y = 0.9;
  const upper = mesh(new THREE.BoxGeometry(1.1, 0.14, 0.14), "#b5bcc0");
  upper.position.x = 0.55;
  const hand = mesh(new THREE.BoxGeometry(0.1, 0.3, 0.2), "#5d666b");
  hand.position.set(1.1, -0.12, 0);
  fore.add(upper, hand);
  arm.add(post, fore);
  robot.add(base, arm);
  robot.userData.arm = arm;
  robot.userData.fore = fore;
  return robot;
}

function chipHtml(state: string, text: string): string {
  const info = STATE_INFO[state];
  const light = state === "material_wait" || state === "labor_wait";
  return `<span class="chip" style="background:${info?.color ?? "#898781"};color:${light ? "#1f2a24" : "#fff"}">${text}</span>`;
}
