// 선종별 배 모양(2.1): 종이로 접은 선체는 같고, 선종마다 다른 갑판 위 구조물(의장)을 탑재 끝에 크레인이 올려 붙인다.
//   VLCC       길고 낮은 선체, 평평한 갑판에 배관 한 줄, 선미 선실
//   컨테이너선  갑판 위 상자 층, 선미 선실
//   LNG선      둥근 탱크 4개(모스형), 선미 선실
//   예인선(4.6)  짧고 뭉툭한 선체에 높은 조타실과 굴뚝, 이물의 방현재(검은 둥근 완충재)와 예인 말뚝
//   피더선(4.6)  작은 컨테이너선: 상자 층 둘, 선미 선실
// 모두 흰 종이(선실은 창문 선만). 색은 공정·손실색과 겹치지 않게 쓰지 않는다. 컨테이너만 종이 색 두어 가지.
// 선체 좌표(model.ts의 hullTris): 갑판 y 0.4, 갑판 폭 z ±0.4, 평평한 갑판 x −0.45~0.45, 이물·고물 끝 x ±1.15.
// 고물(선미)은 −x 쪽이다.

import * as THREE from "three";
import { lookOf } from "./layout";

export interface ShipLook {
  /** 선체 비율 [길이, 높이, 폭] */
  hull: [number, number, number];
  /** 탑재 끝에 붙는 순서대로의 구조물. 마지막이 선실(깃발은 선실 지붕에). */
  parts: THREE.Object3D[];
  /** 깃발 자리(선실 지붕) */
  flagAt: THREE.Vector3;
}

const DECK = 0.4;
const INK = new THREE.Color("#3a3f3c");
const KRAFT = ["#efe7d4", "#d9cba8", "#e6dcc6"];

function paper(color = "#f4f0e6"): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, flatShading: true, roughness: 0.95 });
}

function shadowed<T extends THREE.Mesh>(m: T): T {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 선미 선실: 층층이 줄어드는 종이 상자 둘 + 창문 선 + 굴뚝. */
function deckhouse(x: number, tall: number): { group: THREE.Group; top: number } {
  const g = new THREE.Group();
  const lower = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.24 * tall, 0.62), paper()));
  lower.position.set(x, DECK + 0.12 * tall, 0);
  const upper = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16 * tall, 0.48), paper()));
  upper.position.set(x + 0.01, DECK + 0.24 * tall + 0.08 * tall, 0);
  g.add(lower, upper);
  // 창문 선: 앞면(+x)에 가는 먹선
  const ink = new THREE.MeshBasicMaterial({ color: INK });
  for (const [y, w, fx] of [[DECK + 0.17 * tall, 0.5, x + 0.131], [DECK + 0.33 * tall, 0.38, x + 0.111]] as const) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.025, w), ink);
    line.position.set(fx, y, 0);
    g.add(line);
  }
  const funnel = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.14), paper()));
  const top = DECK + 0.4 * tall;
  funnel.position.set(x - 0.06, top + 0.08, 0);
  g.add(funnel);
  return { group: g, top: top + 0.16 };
}

/** 선종의 3D 모양. 선종 코드가 아니라 rules.json의 look(갑판 위 모양·크기)으로 고른다(4.17, D66) */
export function shipLook(kind: string): ShipLook {
  const parts: THREE.Object3D[] = [];
  const { deck, size } = lookOf(kind);
  const small = size < 1;   // 피더선처럼 작은 컨테이너선은 상자 열이 적고 선체가 짧다
  if (deck === "tug") {
    // 예인선: 이물의 방현재, 예인 말뚝 둘, 높은 조타실과 그 뒤 굴뚝(조타실이 마지막 부품이라 깃발이 거기에 붙는다)
    const fender = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 14), new THREE.MeshStandardMaterial({ color: INK, roughness: 0.9 })));
    fender.rotation.x = Math.PI / 2;
    fender.position.set(0.5, DECK + 0.04, 0);
    parts.push(fender);
    const bitts = new THREE.Group();
    for (const z of [-0.16, 0.16]) {
      const bitt = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.1, 12), paper("#e6dcc6")));
      bitt.position.set(-0.3, DECK + 0.05, z);
      bitts.add(bitt);
    }
    parts.push(bitts);
    const house = new THREE.Group();
    const lower = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.56), paper()));
    lower.position.set(0.05, DECK + 0.13, 0);
    const upper = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.46), paper()));
    upper.position.set(0.06, DECK + 0.36, 0);
    const funnel = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.26, 0.16), paper()));
    funnel.position.set(-0.2, DECK + 0.5, 0);
    const ink = new THREE.MeshBasicMaterial({ color: INK });
    for (const [y, w, fx] of [[DECK + 0.17, 0.46, 0.05 + 0.171], [DECK + 0.38, 0.38, 0.06 + 0.121]] as const) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.028, w), ink);
      line.position.set(fx, y, 0);
      house.add(line);
    }
    house.add(lower, upper, funnel);
    parts.push(house);
    return { hull: [0.85, 1.05, 0.95], parts, flagAt: new THREE.Vector3(0.06, DECK + 0.46, 0) };
  }
  if (deck === "container") {
    // 상자 층: 3열(앞뒤) × 2단(피더선은 2열), 열마다 종이 색을 조금씩 달리
    const bays = small ? 2 : 3;
    for (let bay = 0; bay < bays; bay++) {
      const g = new THREE.Group();
      for (let tier = 0; tier < 2; tier++) {
        for (const z of [-0.18, 0.18]) {
          const box = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), paper(KRAFT[(bay + tier) % KRAFT.length])));
          box.position.set((small ? -0.02 : -0.12) + bay * 0.25, DECK + 0.06 + tier * 0.125, z);
          g.add(box);
        }
      }
      parts.push(g);
    }
    const house = deckhouse(-0.5, 1.05);
    parts.push(house.group);
    return { hull: small ? [1.0, 0.95, 0.9] : [1.1, 1, 0.95], parts, flagAt: new THREE.Vector3(-0.5, house.top, 0) };
  }
  if (deck === "moss") {
    // 모스형 탱크 4개: 갑판 위로 반구가 솟는다
    for (let k = 0; k < 4; k++) {
      const dome = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), paper()));
      dome.position.set(-0.22 + k * 0.29, DECK, 0);
      dome.scale.y = 1.15;
      parts.push(dome);
    }
    const house = deckhouse(-0.56, 1.1);
    parts.push(house.group);
    return { hull: [1.15, 1.05, 1.0], parts, flagAt: new THREE.Vector3(-0.56, house.top, 0) };
  }
  // VLCC: 갑판 가운데 배관 한 줄과 매니폴드
  const pipe = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 12), paper("#e6dcc6")));
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(0.05, DECK + 0.03, 0);
  const manifold = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.5), paper("#e6dcc6")));
  manifold.position.set(0.05, DECK + 0.03, 0);
  const deckGear = new THREE.Group();
  deckGear.add(pipe, manifold);
  parts.push(deckGear);
  const house = deckhouse(-0.52, 1.0);
  parts.push(house.group);
  return { hull: [1.25, 0.88, 1.05], parts, flagAt: new THREE.Vector3(-0.52, house.top, 0) };
}
