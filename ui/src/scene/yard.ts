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
import { LEAD_IN, type Frame, type LotView } from "./frame";
import { mesh, Person, SENIOR_NAME, WORKER_NAMES } from "./people";
import { shipLook } from "./ships";
import { buildDock, buildLand, buildWalls, buildYardLines, GiantHand, SEA_Y, SHORE_X } from "./coast";
import { clamp01, ease, flatOf, hullTris, type Tri } from "../proto/model";
import { STATE_INFO, STATION_COLOR } from "../labels";

// ----- 배치 (해안 조선소 야드 좌표, 단위는 대략 소인 키의 4배. 배경은 coast.ts) -----
const STATION_X = [-9, -3.5, 2, 8.5];
const MAT_W = 3.2, MAT_D = 2.6, MAT_TOP = 0.08;
// 증설한 2호 작업장은 1호 바로 뒤(야드 안쪽)에 놓는다(2.0).
const UNIT2_Z = -2.85, MAT2_D = 2.3;
const unitZ = (unit: number) => (unit === 1 ? UNIT2_Z : 0);
const QUEUE_Z = 2.2;
const LANE_Z = 3.7;
const DEPOT = new THREE.Vector3(-16, 0, LANE_Z);
const LOUNGE = new THREE.Vector3(-15.6, 0, -4.4);   // 소조립 작업장 벽과 겹치지 않게 왼쪽으로
const SHELF_X = [-7.2, -4.7, -2.2];
const SHELF_Z = -6.6;   // 물류창고 구역(벽으로 묶음), 공장 벽 뒤
const LAB = new THREE.Vector3(4.6, 0, -7.2);

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
// 로트: 블록 12개 → 6개 → 3개(도장) → 배(선종마다 다른 갑판 구조물, ships.ts)
// ---------------------------------------------------------------------------

class Lot {
  readonly group = new THREE.Group();
  private readonly units: THREE.Mesh[] = [];
  private readonly unitMat = paperMaterial();
  private readonly sheet: THREE.Mesh;
  /** 절단 자투리: 소조립 정반에서 종이를 자를 때 튀어 나가는 종잇조각. */
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

  constructor(readonly ship: string, kind: string) {
    const geo = new THREE.BoxGeometry(UNIT, 0.22, UNIT);
    for (let u = 0; u < 12; u++) {
      const m = new THREE.Mesh(geo, this.unitMat);
      m.castShadow = true;
      this.units.push(m);
      this.group.add(m);
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
    this.group.add(this.sheet, this.boat, this.tag);
  }

  /** 소조립(절단) 중이면 자투리가 종이 둘레에서 튀어 나갔다가 떨어진다. time은 초. */
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

  /** form: 0 부재(종이 묶음) … 4 배. bench면 소조립 중에 블록이 하나씩 생긴다. */
  setForm(form: number, onBench: boolean): void {
    this.hookX = null;
    const stage = Math.floor(form + 1e-9);
    const t = form - stage;
    this.sheet.visible = stage === 0;
    this.sheet.scale.setScalar(stage === 0 ? 1 - 0.6 * t : 1);
    this.boat.visible = stage >= 3 && (stage === 4 || t > 0);

    // 블록 배치: 6열 × 2행. 짝(열 2개)이 먼저 붙고(12 → 6), 그다음 앞뒤 줄이 붙는다(6 → 3).
    let gp = 0.12, gr = 0.12;
    if (stage === 1) gp = 0.12 * (1 - ease(t));
    if (stage >= 2) gp = 0;
    if (stage === 2) gr = 0.12 * (1 - ease(t));
    if (stage >= 3) gr = 0;
    const gb = 0.22;
    const paint = stage < 2 ? 0 : stage === 2 ? t : 1;
    this.unitMat.color.lerpColors(PAPER, PAINT, paint);
    this.hullMat.color.copy(PAINT);

    const visibleUnits = stage === 0 ? (onBench ? Math.ceil(12 * t) : 0) : 12;
    // 탑재(3 → 4): 대블록 3개를 크레인이 하나씩 배 자리로 옮긴다.
    const moving = stage === 3 ? Math.min(2, Math.floor(t * 3)) : -1;
    const u3 = stage === 3 ? t * 3 - moving : 0;
    const pileX = stage === 3 ? -0.9 : 0;
    const boatX = 0.75;

    this.units.forEach((m, u) => {
      const c = u % 6, r = Math.floor(u / 6);
      const pair = Math.floor(c / 2), within = c % 2;
      const px = (pair - 1) * (2 * UNIT + gb + gp);
      let x = px + (within - 0.5) * (UNIT + gp) + pileX;
      const z = (r - 0.5) * (UNIT + gr);
      let y = 0.11;
      let visible = u < visibleUnits && stage < 4;
      if (stage === 3) {
        if (pair < moving) visible = false;
        else if (pair === moving) {
          // 훅에 매달려 이동: 앞 절반은 들어 옮기고, 뒤 절반이면 이미 배에 붙었다.
          const k = clamp01(u3 / 0.55);
          if (u3 > 0.6) visible = false;
          x = x + (boatX - (px + pileX)) * ease(k);
          y = 0.11 + Math.sin(Math.PI * k) * 1.4;
          this.hookX = px + pileX + (boatX - (px + pileX)) * ease(k);
          this.hookY = y + 0.15;
        }
      }
      m.visible = visible;
      m.position.set(x, y, z);
      m.scale.setScalar(stage === 0 && onBench && u === visibleUnits - 1 ? 0.6 + 0.4 * ((12 * t) % 1) : 1);
    });

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
    tag: CSS2DObject; smoke: THREE.Group; tape: THREE.Group; candle: THREE.PointLight; flame: THREE.Mesh;
    /** 2호 정반과 팻말(증설했을 때만 보인다) */
    mat2: THREE.Mesh; tag2: CSS2DObject;
    /** 로봇 팔(인력이 로봇인 공정). 작업장마다 하나 */
    robots: THREE.Group[];
  }[] = [];
  private readonly carts: { group: THREE.Group; tag: CSS2DObject; smoke: THREE.Group }[] = [];
  private readonly shelves: { boxes: THREE.Mesh[]; tag: CSS2DObject }[] = [];
  private readonly lounge: CSS2DObject;
  private readonly labTag: CSS2DObject;
  private readonly labWindow: THREE.MeshStandardMaterial;
  /** 골리앗 크레인 노릇을 하는 걸리버의 손(하늘에서 수직으로 내려온다). */
  private readonly gulliver = new GiantHand();
  /** 증설한 2호 작업장의 벽·구획선·도크(2호가 있을 때만 보인다). */
  private readonly unit2Areas: THREE.Group[] = [];
  private readonly camGoal = { pos: new THREE.Vector3(3, 13, 26), target: new THREE.Vector3(3, 3, -9) };
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
    this.scene.fog = new THREE.Fog(BG.clone(), 45, 110);
    this.camera.position.copy(this.camGoal.pos);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.copy(this.camGoal.target);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 60;
    this.controls.addEventListener("start", () => { this.camMoving = 0; });

    const { hemi, sun } = this;
    sun.position.set(-9, 17, 11);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 15, bottom: -15, near: 1, far: 60 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(hemi, sun);

    buildLand(this.scene);
    this.buildAreas();
    this.buildStations();
    this.scene.add(this.gulliver.root);
    const craneTag = label("골리앗 크레인 · 걸리버의 손", "place-tag");
    craneTag.position.set(0, 1.5, 0);
    this.gulliver.hand.add(craneTag);
    this.buildLane();
    this.lounge = this.buildLounge();
    this.buildShelves();
    const lab = this.buildLab();
    this.labTag = lab.tag;
    this.labWindow = lab.window;
    const seaTag = label("안벽 · 인도한 배", "place-tag");
    seaTag.position.set(SHORE_X + 3, 0.2, 4.2);
    this.scene.add(seaTag);

    for (let i = 0; i < 8; i++) {
      const p = new Person("worker", i, WORKER_NAMES[i]);
      this.people.push(p);
      this.scene.add(p.root);
    }
    this.scene.add(this.senior.root, this.manager.root);
    this.manager.place(new THREE.Vector3(-1, 0, 5.4), Math.PI, "stand", true);
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

  /** 생산관리자 소인의 이름표: 서명한 닉네임. */
  setManagerName(name: string): void {
    this.manager.setName(name);
  }

  // ----- 구성 -----

  private buildStations(): void {
    STATION_X.forEach((x, i) => {
      const ids = Object.keys(STATION_COLOR);
      const color = STATION_COLOR[ids[i]];
      const mat = mesh(new THREE.BoxGeometry(MAT_W, MAT_TOP, MAT_D), color, { roughness: 0.95 });
      mat.position.set(x, MAT_TOP / 2, 0);
      mat.castShadow = false;
      this.scene.add(mat);
      const tag = label("", "station-tag");
      tag.position.set(x, 0.1, -1.75);
      this.scene.add(tag);

      // 고장: 연기 / 사고: 통제 테이프
      const smoke = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const puff = mesh(new THREE.SphereGeometry(0.22, 20, 14), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.position.set(x + 1.1, 0.4, -0.9);
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
      tape.position.set(x, 0, 0);
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
      candle.position.set(x + MAT_W / 2 + 0.3, 0, -1.2);
      this.scene.add(candle);

      // 2호 정반(증설): 1호 바로 뒤. 처음에는 숨겨 둔다.
      const mat2 = mesh(new THREE.BoxGeometry(MAT_W, MAT_TOP, MAT2_D), color, { roughness: 0.95 });
      mat2.position.set(x, MAT_TOP / 2, UNIT2_Z);
      mat2.castShadow = false;
      mat2.visible = false;
      this.scene.add(mat2);
      const tag2 = label("2호", "place-tag small");
      tag2.position.set(x - MAT_W / 2 - 0.2, 0.1, UNIT2_Z);
      tag2.visible = false;
      this.scene.add(tag2);

      const robots = [0, 1].map((u) => {
        const robot = buildRobot();
        robot.position.set(x + MAT_W / 2 + 0.25, 0, unitZ(u));
        robot.visible = false;
        this.scene.add(robot);
        return robot;
      });

      this.stationProps.push({ tag, smoke, tape, candle: light, flame, mat2, tag2, robots });
    });
  }

  /** 작업장마다: 소조립·중조립은 벽만 있는 공장(앞은 열림), 대조립은 바깥 정반(노란 구획선), 탑재는 드라이 도크. 그리고 물류창고 구역. */
  private buildAreas(): void {
    STATION_X.forEach((x, p) => {
      for (const unit of [0, 1]) {
        const zc = unitZ(unit), d = unit === 1 ? MAT2_D : MAT_D;
        const z0 = zc - d / 2 - 0.3, z1 = zc + d / 2 + (unit === 0 ? 0.35 : 0.05);
        const area = p < 2 ? buildWalls(x - MAT_W / 2 - 0.45, x + MAT_W / 2 + 0.45, z0, z1, 1.0)
          : p === 2 ? buildYardLines(x - MAT_W / 2 - 0.4, x + MAT_W / 2 + 0.4, z0, z1)
          : buildDock(x - MAT_W / 2 - 0.6, x + MAT_W / 2 + 0.6, z0, z1);
        this.scene.add(area);
        if (unit === 1) {
          area.visible = false;
          this.unit2Areas[p] = area;
        }
      }
    });
    this.scene.add(buildWalls(SHELF_X[0] - 1.5, SHELF_X[2] + 1.5, SHELF_Z - 0.9, SHELF_Z + 1.0, 1.9));
  }

  private buildLane(): void {
    const lane = mesh(new THREE.BoxGeometry(SHORE_X - 0.3 - (DEPOT.x - 1.5), 0.02, 1.0), "#9f9a8f", { roughness: 1 });
    lane.position.set((DEPOT.x - 1.5 + SHORE_X - 0.3) / 2, 0.01, LANE_Z);
    lane.castShadow = false;
    this.scene.add(lane);
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
      group.position.set(DEPOT.x, 0, LANE_Z + k * 1.15);
      group.visible = false;
      this.scene.add(group);
      this.carts.push({ group, tag, smoke });
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
      const tag = label("", "shelf-tag");
      tag.position.set(x, 1.75, SHELF_Z + 0.2);
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
    this.scene.add(body, roof, pane);
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
    }
    this.lots.clear();
    ships.forEach(({ id, type }, i) => {
      const lot = new Lot(id, type);
      lot.floatPhase = i * 1.7;
      lot.group.visible = false;
      this.lots.set(id, lot);
      this.scene.add(lot.group);
    });
  }

  setSource(source: DaySource): void {
    this.source = source;
    this.sourceAt = performance.now();
    this.draw(source.snap);
  }

  setCamera(mode: CameraMode, station: number | null = null): void {
    if (mode === "control" || station === null) {
      // 전경: 조금 낮게 비스듬히 봐서 능선 너머 걸리버의 상반신과 만 입구의 등대가 함께 들어오게.
      this.camGoal.pos.set(3, 13, 26);
      this.camGoal.target.set(3, 3, -9);
    } else {
      const x = STATION_X[station];
      this.camGoal.pos.set(x + 2.2, 4.6, 8.2);
      this.camGoal.target.set(x, 0.5, 0.6);
    }
    this.camMoving = 1;
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
    for (const lot of this.lots.values()) {
      if (!lot.group.visible) continue;
      // 대기 줄 → 정반처럼 자리를 옮기는 로트도 준비 시간(1배속 0.15초) 안에 닿게 빨리 옮긴다.
      lot.group.position.lerp(lot.target, Math.min(1, dt * 22));
    }
    this.animateProps(t);
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

    // 로트
    let hook: { x: number; y: number } | null = null;
    for (const view of f.lots) {
      const lot = this.lots.get(view.ship);
      if (!lot) continue;
      lot.group.visible = view.place !== "hidden";
      if (!lot.group.visible) continue;
      const pos = this.lotPosition(view, frac, f);
      lot.target.copy(pos);
      if (jump || view.place === "carried" || view.place === "sea") lot.group.position.copy(pos);
      lot.setForm(view.form, view.place === "bench");
      lot.animateCut(view.place === "bench" && view.station === 0 && (view.state === "work" || view.state === "rework"), performance.now() / 1000);
      if (view.place === "sea") {
        lot.group.rotation.set(Math.sin(lot.floatPhase * 1.1) * 0.03, 0, Math.sin(lot.floatPhase * 1.3) * 0.04);
      } else {
        lot.group.rotation.set(0, 0, 0);
      }
      // 골리앗 크레인 훅은 1호 탑재 정반의 블록을 따라간다(2호는 같은 크레인 아래 안쪽 자리).
      if (view.place === "bench" && view.station === 3 && view.unit === 0 && lot.hookX !== null) hook = { x: lot.hookX, y: lot.hookY };
      setLabel(lot.tag, this.lotLabel(view));
      lot.tag.position.y = view.form >= 3 ? 1.9 : 1.0;
    }

    // 골리앗 크레인(걸리버의 손): 탑재 중이면 자석판이 블록을 따라간다. 쉴 때는 도크 위에 손을 띄워 둔다.
    const hx = STATION_X[3] + (hook ? hook.x : 0);
    const hy = hook ? hook.y + 0.15 : 3.0;
    this.gulliver.place(new THREE.Vector3(hx, hy, 0));

    // 정반: 작업장(1호, 증설하면 2호)마다 인원 또는 로봇, 시니어, 중지, 잔업
    let person = 0;
    f.stations.forEach((st, i) => {
      const x = STATION_X[i];
      const props = this.stationProps[i];
      const working = st.state === "work" || st.state === "rework";
      const robot = st.crew === "robot";
      props.mat2.visible = st.units.length > 1;
      if (this.unit2Areas[i]) this.unit2Areas[i].visible = st.units.length > 1;
      props.tag2.visible = st.units.length > 1;
      props.robots.forEach((r, u) => {
        r.visible = robot && u < st.units.length;
        r.userData.working = robot && (st.units[u]?.state === "work" || st.units[u]?.state === "rework");
      });
      if (!robot) {
        st.units.forEach((unit, u) => {
          const unitWorking = unit.state === "work" || unit.state === "rework";
          for (let k = 0; k < unit.workers; k++) {
            const side = k % 2 === 0 ? 1 : -1;
            const at = new THREE.Vector3(x - 0.9 * side, MAT_TOP, unitZ(u) + side * 1.0);
            const p = this.people[person++];
            p?.place(at, side > 0 ? Math.PI : 0, unitWorking ? "work" : "stand", jump, within);
            p?.holdKnife(i === 0 && unitWorking);
          }
        });
      }
      if (st.senior) {
        this.senior.setVisible(true);
        this.senior.place(new THREE.Vector3(x + 1.3, MAT_TOP, -0.2), -Math.PI / 2, working ? "work" : "stand", jump, within);
        this.senior.holdKnife(i === 0 && working);
      }
      // 멈춘 작업장에 연기(고장)나 통제 테이프(사고). 둘 다 멈췄으면 1호에 표시한다.
      const stopped = st.units.findIndex((u) => u.stop !== null);
      const stop = stopped >= 0 ? st.units[stopped].stop : null;
      props.smoke.visible = stop === "breakdown";
      props.tape.visible = stop === "accident";
      props.smoke.position.z = unitZ(Math.max(0, stopped)) - 0.9;
      props.tape.position.z = unitZ(Math.max(0, stopped));
      props.candle.intensity = st.overtime ? 5 : 0;
      props.flame.visible = st.overtime;
      const chip = st.stop === "accident" ? chipHtml("accident_stop", "사고 · 통제")
        : st.stop === "breakdown" ? chipHtml("breakdown_stop", "고장 · 수리 중")
        : st.state === "labor_wait" ? chipHtml("labor_wait", "인력 대기")
        : st.state === "material_wait" ? chipHtml("material_wait", "자재 대기")
        : i === 0 && working ? `<span class="chip cut">절단 중</span>` : "";
      const crewNote = robot ? " · 로봇" : st.crew === "skilled" ? " · 숙련공" : "";
      setLabel(props.tag, `<i style="background:${STATION_COLOR[st.id]}"></i>${st.name}${st.units.length > 1 ? " 1호" : ""}${crewNote}${st.overtime && !robot ? " · 잔업" : ""}${chip}`);
    });
    if (!f.stations.some((st) => st.senior)) this.senior.setVisible(false);

    // 작업대기소: 오늘 배정되지 않은 사람은 앉아서 기다린다(인원 과다가 보인다).
    for (let k = 0; k < f.idleWorkers && person < this.people.length; k++) {
      this.people[person].holdKnife(false);
      this.people[person++].place(this.loungeSeat(k), 0, "sit", jump, within);
    }
    const used = person;
    this.people.forEach((p, i) => p.setVisible(i < used));
    setLabel(this.lounge, `작업대기소 · 쉬는 사람 <b>${f.idleWorkers}</b>명`);

    // 트랜스포터
    f.transporters.forEach((tr, k) => {
      const cart = this.carts[k];
      cart.group.visible = true;
      const lot = tr.ship ? f.lots.find((l) => l.ship === tr.ship) : undefined;
      let at: THREE.Vector3;
      if (tr.state === "move" && lot) {
        at = lot.place === "carried"
          ? this.lotPosition(lot, frac, f).setY(0)
          : new THREE.Vector3(STATION_X[lot.station] - 1.4, 0, LANE_Z);
      } else if (tr.state === "breakdown_stop") {
        at = cart.group.position.clone();
      } else {
        at = new THREE.Vector3(DEPOT.x, 0, LANE_Z + k * 1.15);
      }
      cart.group.position.lerp(at, jump ? 1 : 0.2);
      // 운반 중인 로트는 트랜스포터가 실으러 온 뒤에야 함께 움직인다(수레보다 앞서 가지 않게).
      // 수레가 아직 멀면 로트는 실을 자리에서 기다린다.
      if (tr.state === "move" && lot?.place === "carried") {
        const lotObj = this.lots.get(lot.ship);
        if (lotObj && cart.group.position.distanceTo(at) < 0.8) lotObj.group.position.copy(cart.group.position).setY(0.32);
      }
      cart.smoke.visible = tr.state === "breakdown_stop";
      setLabel(cart.tag, tr.state === "breakdown_stop" ? `${tr.id} ${chipHtml("breakdown_stop", "고장")}` : tr.id);
    });
    for (let k = f.transporters.length; k < this.carts.length; k++) this.carts[k].group.visible = false;

    // 자재창고: 선반이 비면 "입고 D-n" 팻말
    f.shelves.forEach((sh, i) => {
      const shelf = this.shelves[i];
      const shown = Math.min(sh.qty, shelf.boxes.length);
      shelf.boxes.forEach((b, k) => { b.visible = k < shown; });
      const note = sh.qty > 0 ? `<b>${sh.qty}</b>` : sh.nextArrival ? chipHtml("material_wait", `입고 D-${sh.nextArrival - f.day}`) : "<b>0</b>";
      setLabel(shelf.tag, `${sh.name} ${note}`);
    });

    // 연구소
    const rs = f.research;
    this.labWindow.emissive.set(rs.current ? "#7fd1ff" : "#000000");
    this.labWindow.emissiveIntensity = rs.current ? 0.8 : 0;
    const now = rs.current ? `${rs.current.name} ${rs.current.done}/${rs.current.total}일` : "진행 중인 연구 없음";
    const done = rs.finished.length ? `<br><small>완료: ${rs.finished.join(", ")}</small>` : "";
    setLabel(this.labTag, `연구소 · ${now}${done}`);
  }

  private lotPosition(view: LotView, frac: number, f: Frame): THREE.Vector3 {
    const x = STATION_X[view.station];
    switch (view.place) {
      case "bench": return new THREE.Vector3(x, MAT_TOP, unitZ(view.unit));
      case "queue": return new THREE.Vector3(x - 0.9 - view.slot * 1.9, 0, QUEUE_Z);
      case "outbound": return new THREE.Vector3(x + 1.2 + view.slot * 1.9, 0, QUEUE_Z);
      case "carried": {
        const from = x + 1.2, to = STATION_X[view.station + 1] - 0.9;
        return new THREE.Vector3(from + (to - from) * ease(view.travel ?? frac), 0.32, LANE_Z);
      }
      case "sea": {
        const lot = this.lots.get(view.ship)!;
        lot.floatPhase += 0.016;
        const i = f.lots.filter((l) => l.place === "sea").indexOf(view);
        // 안벽 앞 바다에 세 척씩 두 줄로 띄운다.
        return new THREE.Vector3(SHORE_X + 1.9 + (i % 3) * 2.9, SEA_Y + 0.02 + Math.sin(lot.floatPhase * 1.6) * 0.03, -1.6 + Math.floor(i / 3) * 2.1);
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

  private animateProps(t: number): void {
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
