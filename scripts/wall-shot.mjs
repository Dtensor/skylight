// Screenshot the wall view (software GL, so it works headless).
//   node scripts/wall-shot.mjs <outdir> [query ...]   e.g.  "t=0" "t=240&heading=340"
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [outDir = "docs/wall", ...queries] = process.argv.slice(2);
const base = process.env.WALL_URL ?? "http://localhost:21260/wall";
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
for (const q of queries.length ? queries : ["t=0"]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}?${q}`, { waitUntil: "load" });
  await page.waitForTimeout(Number(process.env.WAIT_MS ?? 14000));
  const file = `${outDir}/wall-${q.replace(/[^a-z0-9.-]+/gi, "_")}.png`;
  await page.screenshot({ path: file });
  console.log("wrote", file, errors.length ? `ERRORS: ${errors.join(" | ")}` : "no page errors");
  await page.close();
}
await browser.close();
