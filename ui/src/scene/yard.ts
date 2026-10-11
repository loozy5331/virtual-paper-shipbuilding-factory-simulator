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
import { LEAD_IN, nextStation, type Delivery, type ForkliftJobView, type Frame, type LotView } from "./frame";
import { buildFirstPersonArms, mesh, Person, SENIOR_NAME, WORKER_NAMES } from "./people";
import { quayWaiting, STOCK_COLOR_OF, STOCK_STATIONS, stockAssign, stockSpot, stockUsed } from "./stock";
import { buildDock, buildLand, buildRoof, buildSectorOutline, buildWalls, buildYardLines, GiantHand, Gulliver, SEA_Y, type DockParts } from "./coast";
import { areaBounds, benchAt, CART_R, CRANE_R, DEPOT, dockQueueZ, dockZ, LAB, LANE_Z, LOUNGE, LOUNGE_SOUTH, loungeOf, fenceSegments, GATES, GATE_W, OUTER_ROAD, MAT_D, MAT_TOP, MAT_W, MAT2_D,
  nearLane, QUEUE_Z, SAFE_SPOT, seaSpot, SECTORS, sector, sectorBounds, DOCK2_AREA, SHELF_X, SHELF_Z, STEEL_YARD, STEEL_CONVEYOR, WAREHOUSE, SEA_EXIT, SHORE_X, SPUR_IN, SPUR_OUT, SPUR_X, STATION_X,
  STOCK_AT, STOCK_D, STOCK_HALF, STOCK_NAME, CONVEYORS, BACK_LANE_Z, garageSpot, FORKLIFT_GARAGE, KIT_PICK, kitDrop, roadPath, palletPath, SPUR_ROADS, type RoadSide, QUAY_WORK_Z, ST, isShop, QUAY_ROAD_Z, QUAY_STORE, QUAY, DEPOT_WALLS, GARAGE_WALLS, depotSpot, along, groundY, LAB_TREES, LAND_ROUTE, route, SHIP_ROUTE, SUPPLY_DAYS, SUPPLY_EXIT, SUPPLY_ROUTE, unitZ, type Route, type SectorId, FIXED_BLOCKERS, LAB_SIZE, panelRect, SAFE_LOOK, walkable, wallPanels, WAREHOUSE_WALLS, type Rect } from "./layout";
import { clamp01, ease } from "./model";
import { Lot } from "./lot";
import { buildHoist, buildRobot, buildSupplyCart, buildSupplyShip, crateTop, type SupplyShip } from "./props";
import { Harbor, type LaunchPose } from "./harbor";
import { chipHtml, label, paperMaterial, setLabel } from "./util";
import { STATE_INFO, STATION_COLOR, STATION_TRADE, TRADE_HAT } from "../labels";
import type { TrackPick } from "../track";

// 배치(야드 좌표)는 layout.ts, 배경은 coast.ts. 증설한 작업장은 1호 뒤로 한 줄씩(2호, 3호, 3.0).
// 구획(3.2, D38): 카메라는 전경 또는 구획 하나(내업, 1도크, 2도크, 안벽). 전경에서는 구획 이름만 보이고, 내업 공장에는 지붕을 덮는다.

// 현장 안전(3.0, D27·D28·D35): 관리자는 평소 작업장에서 떨어진 안전한 자리에 선다. "골리앗 주변으로"·"트랜스포터 주변으로"를
// 누르면 그 설비 옆으로 순간이동하고, 위험 반경이라 경고한다(재생 중 저절로 뜨는 경고는 1인칭 이동이 생길 때로 미룬다).
// 엔진 규칙이 아니라 현장 화면의 규칙이다. 반경은 팻말에 "반경 10m"로 적는다(소인국 척도라 화면 크기는 보기 좋게만).
// 반경은 layout.ts의 CRANE_R(걸리버의 손, 탑재 도크 둘레)과 CART_R(트랜스포터).
// 안전한 자리(layout.ts의 SAFE_SPOT): 내업과 도크 구획 사이 큰길 앞. 크레인 반경과 큰길 트랜스포터 반경 밖이다.
export type ManagerSpot = "safe" | "crane" | "cart";
export interface Hazard { id: string; label: string }
const BG = new THREE.Color("#dbe5ea");   // 하늘

export type CameraMode = "control" | "field";
/** 현장 시점(4.10): third = 위에서 내려다보는 3인칭(기본), first = 관리자 소인의 눈 */
export type FieldView = "third" | "first";
/** 1인칭: 걷는 빠르기(Shift는 2배), 명찰이 보이는 거리, 시야각(3인칭은 40) */
const WALK_SPEED = 2.6, BADGE_R = 5.5, FP_FOV = 62;
/** 1인칭에서 이름표(작업장·설비·블록)가 보이는 거리. 멀리 것까지 띄우면 지평선에 겹쳐 쌓인다 */
const FP_LABEL_R = 12;
/** 내업 공장 벽 높이(4.11.1: 1.0 → 1.6, 1인칭에서 소인 키의 두 배 남짓이면 공장 벽 같지 않았다) */
const SHOP_WALL_H = 1.6;

export interface DaySource {
  /** 그날 안에서 흐른 비율(0~1)을 받아 장면을 돌려준다. */
  frameAt(frac: number): Frame;
  playing: boolean;
  msPerDay: number;
  /** 걷지 않고 바로 옮긴다: 날짜를 건너뛰었거나 배속이 빠를 때. */
  snap: boolean;
}

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
  private readonly lots = new Map<string, Lot>();
  private readonly people: Person[] = [];
  private readonly senior = new Person("senior", 5, SENIOR_NAME);
  private readonly manager = new Person("manager");
  private readonly stationProps: {
    tag: CSS2DObject; smoke: THREE.Group; tape: THREE.Group; candle: THREE.Group; light: THREE.PointLight; flame: THREE.Mesh;
    /** 작업장(1호·2호·3호)마다 정반과 번호 팻말. 2호·3호는 증설했을 때만 보인다 */
    mats: { mat: THREE.Mesh; tag: CSS2DObject }[];
    /** 로봇 팔(인력이 로봇인 공정). 작업장마다 하나 */
    robots: THREE.Group[];
    /** 호이스트(4.9, 소조립·중조립만): 작업장마다 정반 위 천장 크레인 */
    hoists: THREE.Group[];
  }[] = [];
  /** 트랜스포터(4.3, D46): 블록 한 대. 평소에는 소조립·중조립 사이 차고에 큰길과 직각으로 선다 */
  private readonly carts: { group: THREE.Group; tag: CSS2DObject; smoke: THREE.Group }[] = [];
  /** 납품 마차(3.2): 입고일마다 한 대. 사흘 전 등대 곶을 떠나 입고일 아침 창고 뒤에 닿는다(그림만). 여러 대가 함께 길 위에 있을 수 있다 */
  private readonly supply = [0, 1, 2, 3, 4, 5, 6, 7].map(() => buildSupplyCart());
  /** 해상 납품 배(종이 = 철판): 먼바다 → 등대 부두 */
  private readonly ships = [0, 1].map(() => buildSupplyShip());
  private readonly supplyRoute: Route = route(SUPPLY_ROUTE);
  private readonly landRoute: Route = route(LAND_ROUTE);
  private readonly shipRoute: Route = route(SHIP_ROUTE, 1);
  private readonly supplyExit: Route = route(SUPPLY_EXIT);
  private readonly seaExit: Route = route(SEA_EXIT);
  /** 강재 롤러 컨베이어 위 철판(절단이 일하는 날 흐른다) */
  private readonly steelPlates: THREE.Mesh[] = [];
  private steelOn = false;
  private readonly shelves: { boxes: THREE.Mesh[]; tag: CSS2DObject }[] = [];
  /** 자재·블록 추적(3.1): 누르면 상자를 띄울 곳(main.ts), 진하게 볼 배, 선반의 보이지 않는 누름 상자, 추적 중인 배 밑의 고리 */
  private pickHandler: ((pick: TrackPick) => void) | null = null;
  private track: string | null = null;
  private readonly shelfHits: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly trackRing: THREE.Mesh;
  private readonly lounge: CSS2DObject;
  /** 남문 작업대기소 이름표(탑재·의장, 4.7.5) */
  private readonly loungeS: CSS2DObject;
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
  /** 진수 장면(도크 물·문, 예인선, 계류줄, harbor.ts) */
  private readonly harbor = new Harbor(this.scene, this.docks, this.lots);
  /** 오늘 적치장에 놓인 블록과 그 자리(stock.ts) */
  private stock: ReturnType<typeof stockAssign> = new Map();
  /** 골리앗 크레인 노릇을 하는 걸리버의 손(하늘에서 수직으로 내려온다). */
  private readonly gulliver = new GiantHand();
  /** 2호 도크의 골리앗 크레인 = 걸리버의 왼손(도크를 증설했을 때만). 도크마다 크레인이 하나씩이다(3.0). */
  private readonly gulliver2 = new GiantHand(true);
  private readonly craneTag2 = label("골리앗 크레인 2호 · 걸리버의 왼손", "place-tag");
  /** 작업장마다의 벽·구획선·도크(2호·3호는 있을 때만 보인다). [공정][작업장 번호 − 1] */
  private readonly areas: THREE.Group[][] = [];
  /** 내업 공장 지붕(작업장마다). 전경과 다른 구획을 볼 때만 보인다 */
  private readonly roofs: THREE.Group[][] = [];
  /** 안벽 의장품 적치장의 키트 상자(4.7.3, 배마다 하나) */
  private readonly quayCrates: THREE.Mesh[] = [];
  /** 안벽 도로·의장품 적치장 묶음(간이공정처럼 안벽의장을 쓰지 않으면 숨긴다) */
  private readonly quayGroup = new THREE.Group();
  /** 적치장 칸마다 바닥·선·이름표(간이공정이 쓰지 않는 칸은 숨긴다, 4.4) */
  private readonly stockCells: THREE.Object3D[][] = [];
  /** 구획 윤곽과 이름표. 2도크 구획은 도크가 하나면 흐린 "증설 예정지" */
  private readonly sectorMarks = new Map<SectorId, { outline: THREE.Group | null; tag: CSS2DObject }>();
  /** 지금 배치를 맞춘 도크 수(PE장 작업장의 구획이 도크 수에 따라 달라진다) */
  private layoutDocks = 0;
  /** 카메라가 보는 구획. null이면 전경 */
  private focus: SectorId | null = null;
  private readonly camGoal = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private camMoving = 0;
  /** 1인칭(4.10): 바라보는 방향. 4.11부터 W·A·S·D로 걷는다(앞뒤 forward, 옆 strafe, −1~1) */
  private view: FieldView = "third";
  private fpYaw = 0;
  private fpPitch = -0.06;
  private readonly keys = { forward: 0, strafe: 0, run: false };
  /** 1인칭 팔(카메라에 붙음)과 걸음에 따라 흔들리는 박자 */
  private readonly fpArms = buildFirstPersonArms();
  private stride = 0;
  /** 자동 안전 경고(4.10): 지금 관리자가 들어 있는 위험 반경, 들어갈 때 부를 곳(main.ts) */
  private hazardNow: string | null = null;
  private hazardHandler: ((hazard: Hazard) => void) | null = null;

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
    let last: { x: number; y: number } | null = null;
    r.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; last = down; });
    // 1인칭: 끌면 고개를 돌린다(OrbitControls는 꺼 둔다)
    r.domElement.addEventListener("pointermove", (e) => {
      if (this.view !== "first" || !last || !e.buttons) return;
      this.fpYaw -= (e.clientX - last.x) * 0.005;
      this.fpPitch = THREE.MathUtils.clamp(this.fpPitch - (e.clientY - last.y) * 0.004, -1.1, 0.7);
      last = { x: e.clientX, y: e.clientY };
    });
    r.domElement.addEventListener("wheel", (e) => {
      if (this.view !== "first") return;
      e.preventDefault();
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + Math.sign(e.deltaY) * 4, 26, FP_FOV);
      this.camera.updateProjectionMatrix();
    }, { passive: false });
    r.domElement.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pickAt(e.clientX, e.clientY);
      down = null;
      last = null;
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
    this.buildForklifts();
    this.buildAreas();
    this.buildStations();
    this.scene.add(new Gulliver().root, this.gulliver.root);
    const craneTag = label("골리앗 크레인 1호 · 걸리버의 오른손", "place-tag");
    craneTag.position.set(0, 1.5, 0);
    this.gulliver.hand.add(craneTag);
    this.scene.add(this.gulliver2.root);
    this.craneTag2.position.set(0, 1.5, 0);
    this.gulliver2.hand.add(this.craneTag2);
    this.buildLane();
    this.lounge = this.buildLounge();
    this.loungeS = this.buildLounge(LOUNGE_SOUTH);
    this.buildFence();
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
    // 1인칭 팔은 카메라의 자식이라 카메라를 장면에 넣어야 그려진다
    this.fpArms.visible = false;
    this.camera.add(this.fpArms);
    this.scene.add(this.camera);
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
    // 멀리 있으면(1인칭으로 걸어간 뒤) 건물을 뚫고 걷지 않게 바로 옮긴다
    const far = this.manager.root.position.distanceTo(at) > 3;
    const first = this.view === "first";
    this.manager.place(at, first ? SAFE_LOOK : Math.PI, "stand", spot !== "safe" || far || first, 0.4);
    if (first) this.lookFrom(SAFE_LOOK);
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

      // 호이스트(4.9): 블록을 뒤집는 조립 정반(소조립·중조립)에만
      const hoists = i === ST.sub || i === ST.block ? [0, 1, 2].map((u) => {
        const hoist = buildHoist(u === 0 ? MAT_D : MAT2_D);
        hoist.visible = false;
        this.scene.add(hoist);
        return hoist;
      }) : [];

      this.stationProps.push({ tag, smoke, tape, candle, light, flame, mats, robots, hoists });
    });
  }

  /** 작업장마다: 소조립·중조립은 벽만 있는 공장(앞은 열림) + 지붕, PE장은 바깥 정반(노란 구획선), 탑재는 드라이 도크. 그리고 물류창고 구역과 적치장. */
  private buildAreas(): void {
    STATION_X.forEach((_, p) => {
      this.areas[p] = [];
      this.roofs[p] = [];
    });
    // 물류창고: 뒷벽에 문(납품 마차가 뒤에서 상자를 내린다)
    const ww = WAREHOUSE_WALLS;
    this.scene.add(buildWalls(ww.x0, ww.x1, ww.z0, ww.z1, 1.9, ww.door));

    // 적치장: 공정(탑재 제외)마다 칸. 기다리는 블록은 정반 대신 여기에 둔다(내업 두 공정은 큰길 건너편, PE장은 1도크 구획).
    STOCK_AT.slice(0, STOCK_STATIONS).forEach((at, p) => {
      const far = at.z0 + at.dir * STOCK_D;
      const z0 = Math.min(at.z0, far), z1 = Math.max(at.z0, far);
      const floor = mesh(new THREE.BoxGeometry(STOCK_HALF * 2, 0.02, STOCK_D), "#b7b2a6", { roughness: 1 });
      floor.position.set(at.x, 0.011, (z0 + z1) / 2);
      floor.castShadow = false;
      const lines = buildYardLines(at.x - STOCK_HALF, at.x + STOCK_HALF, z0, z1, "#f4f1ea");
      this.scene.add(floor, lines);
      const ids = Object.keys(STATION_COLOR);
      const tag = label(`<i style="background:${STATION_COLOR[ids[STOCK_COLOR_OF[p]]]}"></i>${STOCK_NAME[p]}`, "station-tag small-tag");
      tag.position.set(at.x - STOCK_HALF + 0.9, 0.05, far - at.dir * 0.25);
      this.scene.add(tag);
      this.stockCells[p] = [floor, lines, tag];
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
        const area = isShop(p) ? buildWalls(x0, x1, z0, z1, SHOP_WALL_H)
          : p === ST.pe ? buildYardLines(x0, x1, z0, z1)
          : p === ST.quay ? buildYardLines(x0, x1, z0, z1)   // 안벽 위 작업 구역
          : p > ST.dock ? new THREE.Group()
          : buildDock(x0, x1, z0, z1);
        area.visible = unit === 0;
        this.scene.add(area);
        this.areas[p][unit] = area;
        if (p === ST.dock) this.docks[unit] = area.userData.dock as DockParts;
        if (isShop(p)) {
          const roof = buildRoof(x0, x1, z0, z1, SHOP_WALL_H);
          roof.visible = false;
          this.scene.add(roof);
          this.roofs[p][unit] = roof;
        }
        const b = benchAt(p, unit, docks);
        props.mats[unit].mat.position.set(b.x, MAT_TOP / 2, b.z);
        props.mats[unit].tag.position.set(b.x - MAT_W / 2 - 0.2, 0.1, b.z);
        props.robots[unit].position.set(b.x + MAT_W / 2 + 0.25, 0, b.z);
        props.hoists[unit]?.position.set(b.x, 0, b.z);
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
      mark.outline = sec.id === "quay" ? null : buildSectorOutline(sector(sec.id), false);
      if (mark.outline) this.scene.add(mark.outline);
      // 이름은 구획의 왼쪽 가장자리(작업장 이름표와 겹치지 않게): 도크 구획은 뒤, 나머지는 앞
      mark.tag.position.set(sec.x0 + 2.4, 0.05, sec.id === "dock" ? sec.z0 + 0.4 : sec.z1 - 0.4);
    }
    // 도크가 하나면 큰길 앞 2도크 자리는 흐린 점선과 "2도크 · 증설 예정지"
    if (this.expansion) this.scene.remove(this.expansion.outline);
    this.expansion ??= { outline: new THREE.Group(), tag: label("2도크 · 증설 예정지", "sector-tag faint") };
    this.expansion.outline = buildSectorOutline({ id: "dock", name: "", ...DOCK2_AREA }, true);
    this.expansion.outline.visible = docks < 2;
    this.expansion.tag.visible = docks < 2;
    this.expansion.tag.position.set((DOCK2_AREA.x0 + DOCK2_AREA.x1) / 2, 0.05, DOCK2_AREA.z0 + 1.6);
    this.scene.add(this.expansion.outline, this.expansion.tag);
    if (this.focus) this.setCamera("field", this.focus);
  }

  /** 구획 이름표. 전경에서는 이것만 글로 보인다. 윤곽(바닥의 점선)과 자리는 placeStations가 도크 수에 맞춰 놓는다. */
  private expansion: { outline: THREE.Group; tag: CSS2DObject } | null = null;

  private buildSectors(): void {
    for (const sec of SECTORS) {
      const tag = label(sec.name, "sector-tag");
      this.scene.add(tag);
      this.sectorMarks.set(sec.id, { outline: null, tag });
    }
  }

  private buildLane(): void {
    // 큰길은 서문을 지나 외곽도로까지(4.7.6)
    const laneX0 = OUTER_ROAD.west;
    const lane = mesh(new THREE.BoxGeometry(SHORE_X - 0.3 - laneX0, 0.02, 1.0), "#9f9a8f", { roughness: 1 });
    lane.position.set((laneX0 + SHORE_X - 0.3) / 2, 0.01, LANE_Z);
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
    // 뒷길(4.0.1): 물류창고 앞 가로 도로. 샛길은 뒷길까지 이어진다
    const back = mesh(new THREE.BoxGeometry(SPUR_X[5] - SPUR_X[0] + 0.8, 0.02, 0.9), "#9f9a8f", { roughness: 1 });
    back.position.set((SPUR_X[0] + SPUR_X[5]) / 2, 0.011, BACK_LANE_Z);
    back.castShadow = false;
    this.scene.add(back);
    SPUR_X.forEach((sx, k) => {
      if (!SPUR_ROADS.includes(k)) return;   // 가공 ↔ 소조립 사이는 길이 없다(4.7.1)
      spur(sx, k <= 5 ? BACK_LANE_Z : unitZ(2) - MAT2_D / 2 - 0.4, LANE_Z - 0.5);
      // 큰길 앞으로: 4번(내업·도크 구획 경계)은 남문을 지나 외곽도로까지(4.7.6), 6번은 안벽 도로까지
      if (k >= 4) spur(sx, LANE_Z + 0.5, k === 4 ? OUTER_ROAD.south : k === 6 ? QUAY_ROAD_Z + 0.45 : benchAt(ST.pe, 2, 2).z + MAT2_D / 2 + 0.4);
    });
    // 안벽 도로(4.7.3): PE장·도크 사이 샛길에서 야드 앞쪽을 지나 안벽 뒤를 따라간다(의장품 키트를 나르는 길)
    const quayRoad = mesh(new THREE.BoxGeometry(QUAY.x1 - 0.4 - SPUR_X[6], 0.02, 0.9), "#9f9a8f", { roughness: 1 });
    quayRoad.position.set((SPUR_X[6] + QUAY.x1 - 0.4) / 2, 0.012, QUAY_ROAD_Z);
    quayRoad.castShadow = false;
    this.quayGroup.add(quayRoad);
    // 의장품 적치장(4.7.3): 안벽 왼쪽 끝. 노란 구획선과 이름표, 키트 상자는 drawQuayStore가 날마다 쌓는다
    const store = QUAY_STORE;
    const storeTag = label("의장품 적치장", "station-tag small-tag");
    storeTag.position.set((store.x0 + store.x1) / 2, 0.05, store.z0 + 0.2);
    this.quayGroup.add(buildYardLines(store.x0, store.x1, store.z0, store.z1), storeTag);
    this.scene.add(this.quayGroup);
    for (let k = 0; k < 8; k++) {
      const crate = mesh(new THREE.BoxGeometry(0.42, 0.32, 0.42), "#c9a26b");
      crate.position.set(store.x0 + 0.5 + (k % 4) * 0.56, 0.16, store.z0 + 0.8 + Math.floor(k / 4) * 0.7);
      crate.visible = false;
      this.quayGroup.add(crate);
      this.quayCrates.push(crate);
    }
    // 차고 바닥(4.3): 트랜스포터는 소조립·중조립 사이 큰길 건너편, 지게차는 물류창고 왼쪽 뒷길 가
    const pad = (x: number, z: number, w: number, d: number, text: string, tz: number) => {
      const m = mesh(new THREE.BoxGeometry(w, 0.02, d), "#b7b1a4", { roughness: 1 });
      m.position.set(x, 0.013, z);
      m.castShadow = false;
      const tag = label(text, "place-tag small");
      tag.position.set(x, 0.05, tz);
      this.scene.add(m, tag);
    };
    pad(DEPOT.x, DEPOT.z, 2.5, 1.9, "트랜스포터 차고", DEPOT_WALLS.z1 + 0.3);
    const gw = FORKLIFT_GARAGE.gap * 3;
    pad(FORKLIFT_GARAGE.x + FORKLIFT_GARAGE.gap, FORKLIFT_GARAGE.z, gw, 1.1, "지게차 차고", GARAGE_WALLS.z0 - 0.3);
    // 차고 벽(4.7.3): 정비하는 설비라 뒤·옆에 벽(지붕 없음). 트랜스포터 차고는 큰길 쪽, 지게차 차고는 뒷길 쪽이 열려 있다
    const w = DEPOT_WALLS, gwl = GARAGE_WALLS;
    this.scene.add(buildWalls(w.x0, w.x1, w.z0, w.z1, 0.8, undefined, true), buildWalls(gwl.x0, gwl.x1, gwl.z0, gwl.z1, 0.8));
    for (let k = 0; k < 2; k++) {   // 블록 트랜스포터 두 대까지(4.8)
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
      const tag = label("트랜스포터", "place-tag small");
      tag.position.y = 0.9;
      group.add(tag);
      group.position.set(DEPOT.x, 0, DEPOT.z);
      group.rotation.y = Math.PI / 2;
      group.visible = false;
      this.scene.add(group);
      this.carts.push({ group, tag, smoke });
    }
  }

  /** 작업대기소 하나(벤치 둘). 북서 대기소(LOUNGE)와 남문 대기소(LOUNGE_SOUTH, 4.7.5) */
  private buildLounge(at: { x: number; z: number } = LOUNGE): CSS2DObject {
    const floor = mesh(new THREE.BoxGeometry(4.2, 0.03, 3.0), "#d9d2c3", { roughness: 1 });
    floor.position.set(at.x, 0.015, at.z);
    floor.castShadow = false;
    this.scene.add(floor);
    for (const row of [0, 1]) {
      const bench = mesh(new THREE.BoxGeometry(3.4, 0.12, 0.4), "#9c7b55");
      bench.position.set(at.x, 0.3, at.z - 0.6 + row * 1.2);
      this.scene.add(bench);
    }
    const tag = label("", "place-tag");
    tag.position.set(at.x, 1.3, at.z - 1.2);
    this.scene.add(tag);
    return tag;
  }

  private loungeSeat(i: number, at: { x: number; z: number } = LOUNGE): THREE.Vector3 {
    const row = Math.floor(i / 4) % 2, col = i % 4;   // 8명이 넘으면 같은 자리에 겹쳐 앉는다
    return new THREE.Vector3(at.x - 1.2 + col * 0.8, 0.2, at.z - 0.6 + row * 1.2);
  }

  /** 조선소 담장과 문(4.7.5): 낮은 담(바다 쪽은 열림), 문마다 기둥 둘과 이름표. 남문에서 큰길까지 길 */
  private buildFence(): void {
    for (const s of fenceSegments()) {
      const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
      if (len < 0.05) continue;
      const wall = mesh(new THREE.BoxGeometry(s.x0 === s.x1 ? 0.14 : len, 0.4, s.x0 === s.x1 ? len : 0.14), "#b9b4a8", { roughness: 0.9 });
      wall.position.set((s.x0 + s.x1) / 2, 0.2, (s.z0 + s.z1) / 2);
      this.scene.add(wall);
    }
    for (const g of GATES) {
      const alongX = g.id !== "west";
      for (const side of [-1, 1]) {
        const post = mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), "#8f8a80", { roughness: 0.9 });
        post.position.set(g.x + (alongX ? side * GATE_W / 2 : 0), 0.45, g.z + (alongX ? 0 : side * GATE_W / 2));
        this.scene.add(post);
      }
      const tag = label(g.name, "place-tag");
      tag.position.set(g.x, 1.1, g.z);
      this.scene.add(tag);
    }
    // 외곽도로(4.7.6): 담장 바깥 북·서·남. 북문(납품)·서문(큰길)·남문(샛길)이 닿는다
    const o = OUTER_ROAD;
    const road = (x0: number, z0: number, x1: number, z1: number) => {
      const m = mesh(new THREE.BoxGeometry(Math.abs(x1 - x0) + 0.9, 0.02, Math.abs(z1 - z0) + 0.9), "#a39e92", { roughness: 1 });
      m.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
      m.castShadow = false;
      this.scene.add(m);
    };
    road(o.west, o.north, o.east, o.north);
    road(o.west, o.north, o.west, o.south);
    road(o.west, o.south, SHORE_X, o.south);
  }

  private buildShelves(): void {
    const colors = ["#f7f3ea", "#c8553d", "#c0392b"];
    // 강재 적치장(4.2): 야외 자갈 바닥, 철판 더미 셋(종이 한 장 = 철판 한 장), 롤러 컨베이어로 절단에
    const yard = mesh(new THREE.BoxGeometry(STEEL_YARD.x1 - STEEL_YARD.x0, 0.03, STEEL_YARD.z1 - STEEL_YARD.z0), "#9d978a", { roughness: 1 });
    yard.position.set((STEEL_YARD.x0 + STEEL_YARD.x1) / 2, 0.015, (STEEL_YARD.z0 + STEEL_YARD.z1) / 2);
    yard.castShadow = false;
    this.scene.add(yard);
    const steelSign = label("강재 적치장", "place-tag");
    steelSign.position.set(STEEL_YARD.x, 1.6, STEEL_YARD.z0);
    this.scene.add(steelSign);
    const c = STEEL_CONVEYOR, clen = c.z1 - c.z0;
    const roller = mesh(new THREE.BoxGeometry(c.w, 0.06, clen), "#5d6661", { roughness: 0.9 });
    roller.position.set(c.x, c.y, (c.z0 + c.z1) / 2);
    this.scene.add(roller);
    for (let z = c.z0 + 0.4; z < c.z1; z += 2.4) {
      const leg = mesh(new THREE.BoxGeometry(0.05, c.y, 0.05), "#7d878c");
      leg.position.set(c.x, c.y / 2, z);
      this.scene.add(leg);
    }
    for (let k = 0; k < 3; k++) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.4), paperMaterial());
      plate.visible = false;
      this.steelPlates.push(plate);
      this.scene.add(plate);
    }
    SHELF_X.forEach((x, i) => {
      if (i === 0) {
        // 철판 더미: 3무더기 × 8장 = 24장까지
        const plates: THREE.Mesh[] = [];
        for (let k = 0; k < 24; k++) {
          const pile = k % 3, level = Math.floor(k / 3);
          const pl = mesh(new THREE.BoxGeometry(1.9, 0.07, 1.4), k % 2 ? "#ece6d8" : "#f4f0e6");
          pl.position.set(STEEL_YARD.x - 2.4 + pile * 2.4, 0.06 + level * 0.08, STEEL_YARD.z + 0.1);
          pl.visible = false;
          this.scene.add(pl);
          plates.push(pl);
        }
        const hit = new THREE.Mesh(new THREE.BoxGeometry(7.4, 1.2, 2.4), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
        hit.position.set(STEEL_YARD.x, 0.6, STEEL_YARD.z);
        hit.userData.shelf = i;
        this.scene.add(hit);
        this.shelfHits.push(hit);
        const tag = label("", "shelf-tag");
        tag.position.set(STEEL_YARD.x, 1.1, STEEL_YARD.z + 0.4);
        tag.element.classList.add("pickable");
        tag.element.addEventListener("click", () => {
          const material = this.source?.frameAt(1).shelves[i]?.material;
          if (material) this.pickHandler?.({ kind: "material", material });
        });
        this.scene.add(tag);
        this.shelves.push({ boxes: plates, tag });
        return;
      }
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
    sign.position.set(WAREHOUSE.door, 2.6, SHELF_Z - 0.9);
    this.scene.add(sign);
  }

  private buildLab(): { tag: CSS2DObject; window: THREE.MeshStandardMaterial } {
    const body = mesh(new THREE.BoxGeometry(LAB_SIZE.w, 1.6, LAB_SIZE.d), "#eef2f4");
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
    this.camMoving = this.view === "first" ? 0 : 1;
  }

  /**
   * 3인칭 ↔ 1인칭(4.10). 1인칭이면 관리자 몸을 숨기고 그 눈높이에 카메라를 둔다(끌어서 둘러보기, 휠로 당겨 보기).
   * 3인칭으로 돌아오면 관리자는 걸어간 자리에 그대로 있고, 카메라만 구획 보기로 날아간다.
   */
  setView(view: FieldView): void {
    if (view === this.view) return;
    this.view = view;
    const first = view === "first";
    this.controls.enabled = !first;
    this.manager.setVisible(!first);
    this.camera.fov = first ? FP_FOV : 40;
    // 팔이 눈 바로 앞(0.1 안쪽)에 있어 1인칭에서는 가까운 면을 당긴다
    this.camera.near = first ? 0.02 : 0.1;
    this.camera.updateProjectionMatrix();
    this.fpArms.visible = first;
    this.labels.domElement.classList.toggle("first", first);
    if (first) {
      // 설비 옆(순간이동한 자리)에 있었으면 안전한 자리에서 시작한다
      if (this.managerSpot !== "safe") this.setManagerSpot("safe", this.managerStation);
      this.lookFrom(this.manager.root.rotation.y);
      this.camMoving = 0;
      this.labels.domElement.classList.remove("overview");
    } else {
      this.setMove(0, 0, false);
      for (const p of [...this.people, this.senior]) p.showTag(false);
      this.aim(this.focus);
      this.camMoving = 1;
    }
  }

  /** 1인칭 걷기 입력(main.ts가 W·A·S·D·Shift로): forward = 앞(+1)·뒤(−1), strafe = 오른쪽(+1)·왼쪽(−1) */
  setMove(forward: number, strafe: number, run: boolean): void {
    Object.assign(this.keys, { forward, strafe, run });
  }

  /** 1인칭 카메라를 그 방향(atan2(dx, dz))으로, 고개는 조금 숙인다 */
  private lookFrom(facing: number): void {
    this.fpYaw = facing + Math.PI;
    this.fpPitch = -0.06;
  }

  /** 작업장 벽(내업 공장, 쓰는 작업장만)과 도크 구덩이, 늘 있는 벽·건물 */
  private blockers(): Rect[] {
    const out = [...FIXED_BLOCKERS];
    STATION_X.forEach((_, p) => {
      if (!isShop(p) && p !== ST.dock) return;
      this.areas[p].forEach((area, u) => {
        if (!area?.visible) return;
        const b = areaBounds(p, u, Math.max(1, this.layoutDocks));
        if (p === ST.dock) out.push(b);
        else out.push(...wallPanels(b.x0, b.x1, b.z0, b.z1).map(panelRect));
      });
    });
    return out;
  }

  /** 1인칭 걷기 한 걸음: 바라보는 쪽 기준으로 움직이고, 막히면 벽을 따라 미끄러진다(x·z를 따로 본다) */
  private stepKeys(dt: number): void {
    const { forward, strafe, run } = this.keys;
    if (this.view !== "first" || (!forward && !strafe)) return;
    const sin = Math.sin(this.fpYaw), cos = Math.cos(this.fpYaw);
    let dx = -sin * forward + cos * strafe, dz = -cos * forward - sin * strafe;
    const len = Math.hypot(dx, dz);
    const step = (WALK_SPEED * (run ? 2 : 1) * dt) / len;
    dx *= step;
    dz *= step;
    this.stride += dt * (run ? 2 : 1);
    const pos = this.manager.root.position.clone();
    const blockers = this.blockers();
    if (walkable(pos.x + dx, pos.z, blockers)) pos.x += dx;
    if (walkable(pos.x, pos.z + dz, blockers)) pos.z += dz;
    this.manager.place(pos, Math.atan2(dx, dz), "stand", true);
  }

  /** 위험 반경에 들어가면(설비가 다가왔거나 관리자가 걸어 들어갔거나) 부른다. 관리자는 그 자리에 멈춘다. */
  setHazardHandler(fn: (hazard: Hazard) => void): void {
    this.hazardHandler = fn;
  }

  /** 관리자 자리가 위험 반경 안인가: 골리앗 크레인(늘), 움직이는 트랜스포터 */
  private hazardAt(p: THREE.Vector3): Hazard | null {
    for (let u = 0; u < 2; u++) {
      // 크레인 반경은 일하지 않을 때도 출입 금지(팻말·순간이동 경고와 같게, 4.11.1). 트랜스포터는 움직일 때만
      if (!this.craneRings[u].visible) continue;
      if (Math.hypot(p.x - STATION_X[ST.dock], p.z - dockZ(u)) < CRANE_R) return { id: "crane", label: "골리앗 크레인(걸리버의 손) 작업 반경" };
    }
    for (const ring of this.cartRings) {
      if (ring.visible && Math.hypot(p.x - ring.position.x, p.z - ring.position.z) < CART_R) return { id: "cart", label: "트랜스포터 운행 반경" };
    }
    return null;
  }

  private checkHazard(): void {
    const hazard = this.hazardAt(this.manager.root.position);
    if (hazard && hazard.id !== this.hazardNow) {
      // 그 자리에 멈춘다(경고 카드의 "안전한 자리로 돌아가기"가 옮긴다)
      this.setMove(0, 0, false);
      this.manager.place(this.manager.root.position.clone(), this.manager.root.rotation.y, "stand", true);
      this.hazardHandler?.(hazard);
    }
    this.hazardNow = hazard?.id ?? null;
  }

  /** 1인칭 카메라: 관리자의 눈. 방향은 끌어서 돌린다. */
  private firstPersonCamera(): void {
    const m = this.manager.root.position;
    this.camera.position.set(m.x, m.y + this.manager.eyeHeight(), m.z);
    this.camera.rotation.set(this.fpPitch, this.fpYaw, 0, "YXZ");
    // 걸으면 팔이 위아래·좌우로 조금 흔들린다
    const walking = this.keys.forward !== 0 || this.keys.strafe !== 0;
    const t = this.stride * 9;
    this.fpArms.position.set(walking ? Math.sin(t) * 0.004 : 0, walking ? -Math.abs(Math.cos(t)) * 0.006 : 0, 0);
    // 명찰: 가까운 사람만(멀리까지 띄우면 겹친다)
    for (const p of [...this.people, this.senior]) p.showTag(p.root.visible && p.root.position.distanceTo(m) < BADGE_R);
  }

  private aim(focus: SectorId | null): void {
    this.focus = focus;
    this.labels.domElement.classList.toggle("overview", focus === null && this.view === "third");
    if (focus === null) {
      // 전경: 높이서 비스듬히. 구획 넷과 큰길, 만 입구의 등대가 함께 들어오게.
      // 4.7.6: 등대 곶 바깥 부두의 납품 배까지 들어오게 조금 멀리
      this.camGoal.target.set(-3, 0, 0);
      this.camGoal.pos.set(-3, 54, 57);
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
    this.stepKeys(dt);
    this.checkHazard();
    for (const lot of this.lots.values()) {
      if (!lot.group.visible) continue;
      // 대기 줄 → 정반처럼 자리를 옮기는 로트도 준비 시간(1배속 0.15초) 안에 닿게 빨리 옮긴다.
      const goal = lot.path[0] ?? lot.target;
      if (lot.held) continue;   // 지게차 포크 위(또는 실으러 오기를 기다림): 자리는 driveForklift가 정했다
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
    if (this.view === "first") this.firstPersonCamera();
    else {
      if (this.camMoving > 0) {
        const k = Math.min(1, dt * 3);
        this.camera.position.lerp(this.camGoal.pos, k);
        this.controls.target.lerp(this.camGoal.target, k);
        if (this.camera.position.distanceTo(this.camGoal.pos) < 0.05) this.camMoving = 0;
      }
      this.controls.update();
    }
    this.render();
    this.labels.render(this.scene, this.camera);
    if (this.view === "first") this.hideFarLabels();
  }

  /** 1인칭: 먼 이름표는 감춘다(CSS2DRenderer가 매번 다시 보이게 하므로 그린 뒤에) */
  private hideFarLabels(): void {
    const at = new THREE.Vector3();
    this.scene.traverse((o) => {
      if (!(o instanceof CSS2DObject) || o.element.style.display === "none") return;
      if (o.getWorldPosition(at).distanceTo(this.camera.position) > FP_LABEL_R) o.element.style.display = "none";
    });
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
    let hook: { x: number; y: number; z: number } | null = null;
    let hook2: { x: number; y: number; z: number } | null = null;   // 2호 도크(왼손)
    // 진수: 재생 중 하루 안의 비율로 단계를 나눈다(멈춰 있으면 frac = 1이라 다 끝난 모습).
    // 진수 중인 배와 이틀 안의 진행(g). 도크(물·문·작업자·다음 블록)는 첫날만
    const launching = src.playing ? f.launches.map((l) => ({ ...l, g: (l.day + frac) / 2 })) : [];
    const docking = launching.filter((l) => l.day === 0);
    this.harbor.drawLaunchDocks(docking);
    const towed: ({ lot: Lot; pose: LaunchPose; g: number } | null)[] = [null, null];
    for (const view of f.lots) {
      const lot = this.lots.get(view.ship);
      if (!lot) continue;
      // 인도한 배(sea)는 선주에게 넘어가 조선소를 떠났다(화면 오른쪽 위 인도 완료 로그에 남는다)
      // 인도한 배는 떠났고, 시운전 중인 배는 먼바다에 나가 있다(화면 오른쪽 아래 말풍선)
      lot.group.visible = view.place !== "hidden" && view.place !== "sea" && !(view.place === "bench" && view.station === ST.trial);
      if (!lot.group.visible) continue;
      const launch = launching.find((l) => l.ship === view.ship);
      if (launch) {
        // 진수하는 배: 도크에서 물에 뜨고, 예인선이 문 밖으로 끌어내 안벽 선석(또는 정박지)에 댄다
        lot.setForm(4, false);
        const pose = this.harbor.launchPose(launch.unit, launch.g, this.lotPosition(view, frac, f), lot);
        lot.group.rotation.set(0, pose.yaw, 0);
        lot.group.position.copy(pose.pos);
        towed[launch.unit] = { lot, pose, g: launch.g };
        lot.target.copy(lot.group.position);
        lot.prev = null;
        setLabel(lot.tag, this.lotLabel(view));
        continue;
      }
      // 진수가 끝날 때까지 다음 블록은 도크 앞에서 기다린다
      const held = view.place === "bench" && view.station === ST.dock && docking.some((l) => l.unit === view.unit);
      const pos = held ? new THREE.Vector3(STATION_X[ST.dock] - 0.9, 0, dockQueueZ(view.unit)) : this.lotPosition(view, frac, f);
      lot.target.copy(pos);
      if (view.place !== "carried") lot.loaded = false;
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
      // 탑재 첫날 아침: PE장 정반(어제 그 배가 있던 작업장)에서 도크로 옮기는 중이면 그 거리(4.7.5)
      let lift: { dx: number; dz: number; k: number } | null = null;
      if (view.lift && view.place === "bench" && view.station === ST.dock && !jump) {
        const from = benchAt(ST.pe, view.lift.fromUnit, docks), to = benchAt(ST.dock, view.unit, docks);
        lift = { dx: from.x - to.x, dz: from.z - to.z, k: view.lift.k };
        lot.group.position.copy(pos);   // 로트 자리는 도크, 블록은 PE장에서 손이 옮긴다(미끄러져 가지 않게)
        lot.path = [];
      }
      lot.setForm(view.form, view.place === "bench", lift);
      lot.animateCut(view.place === "bench" && view.station === ST.cut && (view.state === "work" || view.state === "rework"), performance.now() / 1000);
      if (view.place === "sea") {
        lot.group.rotation.set(Math.sin(lot.floatPhase * 1.1) * 0.03, 0, Math.sin(lot.floatPhase * 1.3) * 0.04);
      } else {
        lot.group.rotation.set(0, 0, 0);
      }
      // 골리앗 크레인 훅은 1호 탑재 정반의 블록을 따라간다(2호는 같은 크레인 아래 안쪽 자리).
      if (!held && view.place === "bench" && view.station === ST.dock && lot.hookX !== null) {
        if (view.unit === 0) hook = { x: lot.hookX, y: lot.hookY, z: lot.hookZ };
        else if (view.unit === 1) hook2 = { x: lot.hookX, y: lot.hookY, z: lot.hookZ };
      }
      setLabel(lot.tag, this.lotLabel(view));
      lot.tag.position.y = view.form >= 3 ? 1.9 : 1.0;
    }

    towed.forEach((t, u) => this.harbor.drawTugs(u, t));
    this.harbor.drawMoorings(f, launching);

    // 골리앗 크레인(걸리버의 손): 탑재 중이면 자석판이 블록을 따라간다. 쉴 때는 도크 위에 손을 띄워 둔다.
    // 도크마다 손이 하나: 1호 = 오른손, 2호 = 왼손(2호가 있을 때만). 진수 중이면 그 도크의 손이 문을 열고 닫는다.
    const hands: [GiantHand, { x: number; y: number; z: number } | null, number][] = [[this.gulliver, hook, 0], [this.gulliver2, hook2, 1]];
    for (const [hand, hk, u] of hands) {
      this.craneRings[u].visible = u < docks;
      if (u === 1) this.craneTag2.visible = u < docks;
      // 도크가 하나면 왼팔은 크레인 일을 하지 않고 구름 위에서 턱을 괸다
      if (u >= docks) { hand.rest(); continue; }
      const at = new THREE.Vector3(STATION_X[ST.dock] + (hk ? hk.x : 0), hk ? hk.y + 0.15 : 3.0, dockZ(u) + (hk ? hk.z : 0));
      const launch = docking.find((l) => l.unit === u);
      const gate = launch ? this.harbor.gateHand(u, launch.g) : null;
      hand.place(gate ? at.lerp(gate.at, gate.k) : at);
    }
    // 컨베이어벨트: 판을 올리는 공정(절단, 가공)이 일하는 날 판이 흘러간다
    this.beltOn = CONVEYORS.map((c) => { const st = f.stations[c.from]; return !!st && (st.state === "work" || st.state === "rework"); });
    this.craneActive = [0, 1].map((u) => (u === 0 ? hook : hook2) !== null || docking.some((l) => l.unit === u));

    // 정반: 작업장(1호, 증설하면 2호)마다 인원 또는 로봇, 시니어, 중지, 잔업
    let person = 0;
    // 내업 지붕은 전경이나 다른 구획을 볼 때만(내업을 가까이 보면 지붕과 철골을 통째로 숨긴다, D38)
    const roofsOn = this.view === "third" && this.focus !== "shop";
    // 간이공정(4.4): 쓰지 않는 공정의 작업장·이름표·적치장 칸은 숨겨 빈 땅으로 둔다(공장 벽·지붕도)
    this.stockCells.forEach((cell, p) => { for (const o of cell) o.visible = stockUsed(f, p); });
    const quayTag = this.sectorMarks.get("quay")?.tag;
    if (quayTag) quayTag.visible = !f.stations[ST.quay]?.skipped;
    f.stations.forEach((st, i) => {
      const props = this.stationProps[i];
      const working = st.state === "work" || st.state === "rework";
      const robot = st.crew === "robot";
      const bench = (u: number) => benchAt(i, u, docks);
      props.mats.forEach((e, u) => {
        const on = u < st.units.length && !st.skipped;
        e.mat.visible = on && i <= ST.dock;   // 안벽의장·시운전은 물 위(정반 없음)
        e.tag.visible = on && st.units.length > 1 && u > 0;
        if (this.areas[i][u]) this.areas[i][u].visible = on;
        if (this.roofs[i][u]) this.roofs[i][u].visible = on && roofsOn;
      });
      props.hoists.forEach((hst, u) => {
        hst.visible = st.hoist && u < st.units.length && !st.skipped;
        hst.userData.working = st.units[u]?.state === "work" || st.units[u]?.state === "rework";
      });
      props.robots.forEach((r, u) => {
        r.visible = robot && u < st.units.length;
        r.userData.working = robot && (st.units[u]?.state === "work" || st.units[u]?.state === "rework");
      });
      if (!robot && i !== ST.trial) {   // 시운전 외부팀은 배와 함께 먼바다에 있다
        st.units.forEach((unit, u) => {
          const unitWorking = unit.state === "work" || unit.state === "rework";
          // 진수하는 도크의 작업자는 도크 밖(앞쪽)으로 비켜 선다
          const out = i === ST.dock && docking.some((l) => l.unit === u);
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
        const out = i === ST.dock && docking.length > 0;
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
      props.tag.visible = i !== ST.trial && !st.skipped;
      props.candle.visible = !st.skipped;
      setLabel(props.tag, `<i style="background:${STATION_COLOR[st.id]}"></i>${st.name}${st.units.length > 1 ? " 1호" : ""}${crewNote}${st.overtime && !robot ? " · 잔업" : ""}${chip}`);
    });
    if (!f.stations.some((st) => st.senior)) this.senior.setVisible(false);

    // 작업대기소: 오늘 배정되지 않은 사람은 앉아서 기다린다(인원 과다가 보인다).
    // 직종마다 모자 색으로(4.0, D42)
    // 탑재·의장 직종은 남문 작업대기소(4.7.5), 나머지는 북서 작업대기소
    const seats = new Map<{ x: number; z: number }, number>();
    for (const [trade, n] of Object.entries(f.idleByTrade)) {
      const at = loungeOf(trade);
      for (let k = 0; k < n && person < this.people.length; k++) {
        const seat = seats.get(at) ?? 0;
        seats.set(at, seat + 1);
        this.people[person].holdKnife(false);
        this.people[person].setHat(TRADE_HAT[trade] ?? TRADE_HAT.assembly);
        this.people[person++].place(this.loungeSeat(seat, at), 0, "sit", jump, within);
      }
    }
    const used = person;
    this.people.forEach((p, i) => p.setVisible(i < used));
    const idleAt = (at: { x: number; z: number }) => Object.entries(f.idleByTrade).reduce((s, [tr, n]) => s + (loungeOf(tr) === at ? n : 0), 0);
    setLabel(this.lounge, `작업대기소 · 쉬는 사람 <b>${idleAt(LOUNGE)}</b>명`);
    setLabel(this.loungeS, `남문 작업대기소(탑재·의장) · 쉬는 사람 <b>${idleAt(LOUNGE_SOUTH)}</b>명`);

    // 지게차를 먼저: 날마다 로트의 held를 지우고 팔레트를 잡는다(트랜스포터가 실은 블록의 held는 그 뒤에 잡는다)
    this.driveForklifts(f, src.playing && !jump ? frac : 1);
    // 안벽 의장품 적치장: 내려 둔 키트 상자(배마다 하나)
    this.quayCrates.forEach((c, i) => { c.visible = i < f.quayKits.length; });
    this.quayGroup.visible = !f.stations[ST.quay]?.skipped;

    // 트랜스포터(블록 한 대, 4.3): 나르는 날은 블록과 함께, 쉬는 날은 차고에 큰길과 직각으로
    f.transporters.forEach((tr, k) => {
      const cart = this.carts[k];
      if (!cart) return;
      cart.group.visible = true;
      const lot = tr.ship ? f.lots.find((l) => l.ship === tr.ship) : undefined;
      let at: THREE.Vector3;
      let parked = false;
      if (tr.state === "move" && lot) {
        at = lot.place === "carried"
          ? this.lotPosition(lot, frac, f).setY(0)
          : new THREE.Vector3(STATION_X[lot.station] - 1.4, 0, LANE_Z);
        // 두 대가 같은 구간을 달리면 겹치지 않게 2호는 한 대 길이만큼 뒤에서(4.8)
        if (k > 0) at.x -= 3.0;
      } else if (tr.state === "breakdown_stop") {
        at = cart.group.position.clone();
      } else {
        const spot = depotSpot(k);
        at = new THREE.Vector3(spot.x, 0, spot.z);
        parked = true;
      }
      cart.group.position.lerp(at, jump ? 1 : 0.2);
      // 차고에 거의 닿으면 직각으로 돌려 세운다(큰길 위에서는 길 방향)
      if (tr.state !== "breakdown_stop") cart.group.rotation.y = parked ? Math.PI / 2 : 0;
      cart.group.userData.moving = tr.state === "move";
      // 운반 중인 로트는 트랜스포터가 실으러 온 뒤에야 함께 움직인다(수레보다 앞서 가지 않게, 4.7.3에 고침:
      // 전에는 로트가 제 운반 자리로 먼저 가 있어 차고에서 오는 트랜스포터를 앞질렀다).
      // 수레가 아직 멀면 로트는 실을 자리(운반 출발점)에서 기다리고, 닿으면 수레 위에 얹혀 함께 간다.
      if (tr.state === "move" && lot?.place === "carried") {
        const lotObj = this.lots.get(lot.ship);
        if (lotObj) {
          lotObj.held = true;
          const loaded = cart.group.position.distanceTo(at) < 0.8 || lotObj.loaded;
          lotObj.loaded = loaded;
          if (loaded) lotObj.group.position.copy(cart.group.position).setY(0.32);
          else lotObj.group.position.copy(this.lotPosition({ ...lot, travel: 0 }, 0, f));
        }
      }
      cart.smoke.visible = tr.state === "breakdown_stop";
      const name = f.transporters.length > 1 ? `트랜스포터 ${k + 1}호` : "트랜스포터";
      setLabel(cart.tag, tr.state === "breakdown_stop" ? `${name} ${chipHtml("breakdown_stop", "고장")}` : name);
    });
    for (let k = f.transporters.length; k < this.carts.length; k++) this.carts[k].group.visible = false;

    const cutSt = f.stations[ST.cut];
    this.steelOn = !!cutSt && (cutSt.state === "work" || cutSt.state === "rework");

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
        // 종이(해상)는 강재 적치장 뒤, 물감·깃발(육로)은 창고 뒷문에서 내린다(4.2)
        const out = dv.route === "sea" ? this.seaExit : this.supplyExit;
        if (t < 0.3) { at = along(out, 0); unloaded = playing ? Math.min(1, t / 0.25) : 1; }
        else if (t < 0.75 || !playing) { at = along(out, playing ? ease((t - 0.3) / 0.45) : 0); unloaded = 1; }
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
    if (before.station === ST.proc && now.station === ST.sub) { lot.path = []; return; }   // 지게차가 나른다(driveForklift)
    const belt = CONVEYORS.find((c) => c.from === before.station && now.station === before.station + 1);
    if (belt && before.place === "bench") {
      // 절단 → 가공: 컨베이어벨트 위로 올라 벨트를 따라 간다(D43)
      const c = belt;
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
          const q = quayWaiting(f).get(view.ship);
          if (q) return new THREE.Vector3(q.x, SEA_Y + 0.02, q.z);
        }
        return new THREE.Vector3(x - 0.9 - view.slot * 1.9, 0, QUEUE_Z);
      }
      case "carried": {
        const from = x + 1.2, to = STATION_X[nextStation(f, view.station)] - 0.9;
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

  /**
   * 공용 지게차(4.3, D46): 대마다 자재 키트(물류창고 → 그 공정 앞)와 부재 팔레트(가공 → 소조립)를 나른다.
   * 평소에는 물류창고 왼쪽 차고에 뒷길을 보고 선다. pallet = 포크 위 나무 받침, crate = 키트 상자.
   */
  private readonly forklifts: { group: THREE.Group; pallet: THREE.Group; crate: THREE.Mesh; tag: CSS2DObject; smoke: THREE.Group }[] = [];

  private buildForklifts(): void {
    for (let k = 0; k < 3; k++) {
      const group = new THREE.Group();
      const body = mesh(new THREE.BoxGeometry(0.75, 0.32, 0.5), "#e0b43a", { roughness: 0.7 });
      body.position.set(-0.15, 0.3, 0);
      const cab = mesh(new THREE.BoxGeometry(0.32, 0.36, 0.46), "#3a3f3c", { roughness: 0.8 });
      cab.position.set(-0.25, 0.64, 0);
      const mast = mesh(new THREE.BoxGeometry(0.06, 0.95, 0.42), "#5d6661");
      mast.position.set(0.26, 0.5, 0);
      const forks = [-0.12, 0.12].map((z) => { const f = mesh(new THREE.BoxGeometry(0.55, 0.03, 0.06), "#5d6661"); f.position.set(0.55, 0.1, z); return f; });
      const wheels = [[-0.38, 0.22], [-0.38, -0.22], [0.12, 0.22], [0.12, -0.22]].map(([x, z]) => {
        const w = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 16), "#222"); w.rotation.x = Math.PI / 2; w.position.set(x, 0.11, z); return w;
      });
      // 팔레트(나무 받침): 부재를 실어 나를 때 포크 위에. 키트 상자: 자재 키트를 나를 때 받침 위에
      const pallet = new THREE.Group();
      const deck = mesh(new THREE.BoxGeometry(0.6, 0.05, 0.5), "#a8865a", { roughness: 1 });
      deck.position.set(0.55, 0.15, 0);
      pallet.add(deck);
      const crate = mesh(new THREE.BoxGeometry(0.5, 0.32, 0.42), "#c9a26b");
      crate.position.set(0.55, 0.34, 0);
      const smoke = new THREE.Group();
      for (let n = 0; n < 3; n++) {
        const puff = mesh(new THREE.SphereGeometry(0.12, 12, 10), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.visible = false;
      const tag = label(`지게차 F${k + 1}`, "place-tag small");
      tag.position.y = 1.15;
      group.add(body, cab, mast, ...forks, ...wheels, pallet, crate, smoke, tag);
      const home = garageSpot(k);
      group.position.set(home.x, 0, home.z);
      group.rotation.y = -Math.PI / 2;   // 뒷길 쪽(+z)을 본다
      group.visible = false;
      this.scene.add(group);
      this.forklifts.push({ group, pallet, crate, tag, smoke });
    }
  }

  /**
   * 지게차 하루 시간표(4.3): 그날 일감을 차례로 한다. 첫 구간(차고 → 첫 싣는 자리)은 준비 시간(LEAD_IN) 안에,
   * 나머지(싣고 내리고, 다음 일감, 차고로 돌아오기)는 남은 하루에 길이 비례로 달린다. 부재 팔레트는 실을 때까지 가공 정반에서 기다린다.
   * 멈춰 있거나(frac 1) 일감이 없으면 차고에 서 있다.
   */
  private driveForklifts(f: Frame, frac: number): void {
    for (const lot of this.lots.values()) lot.held = false;
    this.forklifts.forEach((fk, k) => {
      const view = f.forklifts[k];
      fk.group.visible = !!view;
      if (!view) return;
      const home = garageSpot(k);
      const legs: { r: Route; job: ForkliftJobView | null }[] = [];
      const picks = new Map<ForkliftJobView, { x: number; z: number }>();
      let at: { x: number; z: number } = home, side: RoadSide = "back";
      for (const job of view.state === "move" ? view.jobs : []) {
        if (job.kind === "kit") {
          const drop = kitDrop(job.station), ds: RoadSide = job.station === ST.quay ? "quay" : "lane";
          legs.push({ r: roadPath(at, side, KIT_PICK, "back"), job: null }, { r: roadPath(KIT_PICK, "back", drop, ds), job });
          at = drop; side = ds;
        } else {
          const lot = this.lots.get(job.ship);
          const bench = benchAt(ST.proc, job.unit, this.layoutDocks);
          const pick = { x: bench.x + 0.9, z: bench.z };
          const drop = lot ? { x: lot.target.x, z: lot.target.z } : kitDrop(ST.sub);
          picks.set(job, { x: bench.x, z: bench.z });
          // 소조립 정반에 바로 들어가면 그 작업장 번호(아니면 적치장)
          const sub = f.lots.find((l) => l.ship === job.ship && l.station === ST.sub && l.place === "bench");
          legs.push({ r: roadPath(at, side, pick, "lane"), job: null }, { r: palletPath(job.unit, drop, sub ? sub.unit : null, this.layoutDocks), job });
          at = drop; side = "lane";
        }
      }
      if (legs.length) legs.push({ r: roadPath(at, side, home, "back"), job: null });

      let pos: { x: number; z: number; angle: number } | null = null, leg = -1;
      if (legs.length && frac < 1) {
        if (frac < LEAD_IN) { leg = 0; pos = along(legs[0].r, frac / LEAD_IN); }
        else {
          const lens = legs.slice(1).map((l) => l.r.len[l.r.len.length - 1]);
          let d = (frac - LEAD_IN) / (1 - LEAD_IN) * lens.reduce((a, b) => a + b, 0);
          leg = 1;
          while (leg < legs.length - 1 && d > lens[leg - 1]) { d -= lens[leg - 1]; leg++; }
          pos = along(legs[leg].r, lens[leg - 1] ? d / lens[leg - 1] : 1);
        }
      }
      const carry = leg >= 0 ? legs[leg].job : null;
      if (pos) {
        fk.group.position.set(pos.x, 0, pos.z);
        fk.group.rotation.y = -pos.angle;
      } else if (view.state !== "breakdown_stop") {
        fk.group.position.set(home.x, 0, home.z);
        fk.group.rotation.y = -Math.PI / 2;
      }
      fk.pallet.visible = !!carry;
      fk.crate.visible = carry?.kind === "kit";
      fk.smoke.visible = view.state === "breakdown_stop";
      setLabel(fk.tag, view.state === "breakdown_stop" ? `지게차 F${k + 1} ${chipHtml("breakdown_stop", "고장")}` : `지게차 F${k + 1}`);
      // 차고에 서 있으면 이름표를 숨긴다(차고 팻말과 겹친다). 일하거나 고장 나면 보인다
      fk.tag.visible = !!pos || view.state === "breakdown_stop";
      // 부재 팔레트: 실을 구간 전에는 가공 정반에서 기다리고, 싣는 구간에는 포크(앞 0.55) 위에
      legs.forEach((l, n) => {
        if (l.job?.kind !== "pallet") return;
        const lot = this.lots.get(l.job.ship);
        if (!lot || leg < 0 || n < leg) return;
        lot.held = true;
        if (n > leg) {
          const p = picks.get(l.job)!;
          lot.group.position.set(p.x, MAT_TOP, p.z);
        } else {
          const fx = Math.cos(fk.group.rotation.y), fz = -Math.sin(fk.group.rotation.y);
          lot.group.position.set(fk.group.position.x + fx * 0.55, 0.22, fk.group.position.z + fz * 0.55);
        }
      });
    });
  }

  /** 컨베이어벨트 위 판(절단이 일하는 동안 벨트를 따라 가공 쪽으로 흘러간다) */
  private readonly beltPlates: THREE.Mesh[][] = [];
  private beltOn: boolean[] = [];

  /** 컨베이어벨트(D43): 가공 공장 안, 절단 정반에서 가공 정반까지 */
  private buildConveyor(): void {
    CONVEYORS.forEach((c, n) => {
      const len = c.x1 - c.x0 + 0.6, cx = (c.x0 + c.x1) / 2;
      const belt = mesh(new THREE.BoxGeometry(len, 0.08, c.w), "#3a3f3c", { roughness: 0.9 });
      belt.position.set(cx, c.y, c.z);
      const rails = [-1, 1].map((side) => {
        const r = mesh(new THREE.BoxGeometry(len, 0.12, 0.05), "#9aa3a8");
        r.position.set(cx, c.y + 0.04, c.z + side * (c.w / 2 + 0.02));
        return r;
      });
      this.scene.add(belt, ...rails);
      for (const x of [c.x0 - 0.2, cx, c.x1 + 0.2]) for (const side of [-1, 1]) {
        const leg = mesh(new THREE.BoxGeometry(0.06, c.y, 0.06), "#7d878c");
        leg.position.set(x, c.y / 2, c.z + side * c.w / 2);
        this.scene.add(leg);
      }
      this.beltPlates[n] = [];
      for (let k = 0; k < 3; k++) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.24), paperMaterial());
        plate.castShadow = true;
        plate.visible = false;
        this.beltPlates[n].push(plate);
        this.scene.add(plate);
      }
    });
  }

  private animateProps(t: number): void {
    const sc = STEEL_CONVEYOR;
    this.steelPlates.forEach((plate, k, all) => {
      plate.visible = this.steelOn;
      if (!this.steelOn) return;
      const u = (t * 0.12 + k / all.length) % 1;
      plate.position.set(sc.x, sc.y + 0.05, sc.z0 + (sc.z1 - sc.z0) * u);
    });
    CONVEYORS.forEach((c, n) => this.beltPlates[n]?.forEach((plate, k, all) => {
      const on = !!this.beltOn[n];
      plate.visible = on;
      if (!on) return;
      const u = (t * 0.3 + k / all.length) % 1;
      plate.position.set(c.x0 - 0.2 + (c.x1 - c.x0 + 0.4) * u, c.y + 0.06, c.z);
    }));
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
      // 호이스트: 일하는 동안 거더가 정반 위를 오가고 트롤리가 가로로 움직인다(쉴 때는 가운데)
      p.hoists.forEach((hst, u) => {
        if (!hst.visible) return;
        const w = hst.userData.working ? 1 : 0;
        (hst.userData.bridge as THREE.Object3D).position.x = Math.sin(t * 0.7 + i + u) * MAT_W * 0.32 * w;
        (hst.userData.trolley as THREE.Object3D).position.z = Math.sin(t * 1.1 + u) * (hst.userData.depth as number) * 0.25 * w;
      });
    });
    this.carts.forEach((c) => puffs(c.smoke, 1.4));
  }
}
