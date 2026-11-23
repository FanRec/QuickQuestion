import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 离屏渲染走 SVG-as-image 的隔离上下文：外部字体和图片都取不到，
// 必须把 KaTeX 字体和吉祥物预先转成 data URI，随 CSS/HTML 一起内联。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const katexCssPath = path.join(root, "node_modules/katex/dist/katex.min.css");
const fontDir = path.join(root, "node_modules/katex/dist/fonts");
const mascotPath = path.join(root, "src/assets/mascot-face.png");
const outPath = path.join(root, "src/lib/inline-assets.ts");

const katexCss = fs.readFileSync(katexCssPath, "utf8");
const patched = katexCss.replace(/@font-face\s*\{[^}]*\}/g, (face) => {
  const hit = face.match(/url\(fonts\/([^)]+\.woff2)\)/);
  if (!hit) return face;
  const bytes = fs.readFileSync(path.join(fontDir, hit[1]));
  const uri = `data:font/woff2;base64,${bytes.toString("base64")}`;
  return face.replace(/src\s*:\s*[^}]+/, `src:url(${uri}) format("woff2")`);
});

// 生成物自证：残留相对路径会直接让离屏公式退化成方框，宁可构建失败。
const leftover = patched.match(/url\(fonts\/[^)]+\)/g);
if (leftover?.length) {
  throw new Error(`KaTeX CSS 仍有 ${leftover.length} 处相对字体路径：${leftover[0]}`);
}

const mascot = fs.readFileSync(mascotPath);
const mascotUri = `data:image/png;base64,${mascot.toString("base64")}`;

const output =
  "// 由 scripts/gen-inline-assets.mjs 生成，勿手改。\n" +
  "// KaTeX 升级或替换吉祥物后运行 npm run gen:inline-assets 重新生成。\n" +
  `export const KATEX_CSS_INLINE = ${JSON.stringify(patched)};\n` +
  `export const MASCOT_DATA_URI = ${JSON.stringify(mascotUri)};\n`;

fs.writeFileSync(outPath, output);
console.log(`inline-assets.ts: ${(Buffer.byteLength(output) / 1024).toFixed(0)} KB`);
