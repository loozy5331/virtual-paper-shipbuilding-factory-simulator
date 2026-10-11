// 화면 빌드: src/main.ts와 src/styles.css를 dist로 묶고 index.html을 복사한다.
//   node build.mjs           한 번 빌드
//   node build.mjs --watch   파일이 바뀔 때마다 다시 빌드
import { build, context } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: { app: "src/main.ts", styles: "src/styles.css" },
  outdir: "dist",
  bundle: true,
  splitting: true,          // 3D(Three.js)는 처음 열 때만 불러오도록 따로 묶는다.
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
};

// 해시 이름 조각(yard-XXXX.js 등)이 빌드마다 쌓이지 않게 먼저 비운다.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await copyFile("index.html", "dist/index.html");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("바뀌는 파일을 지켜보는 중입니다. 서버는 다른 터미널에서 python server/app.py 로 실행하세요.");
} else {
  await build(options);
}
