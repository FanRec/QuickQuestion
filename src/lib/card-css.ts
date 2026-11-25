/**
 * 贴片渲染的固定骨架与样式基线。
 *
 * 骨架（DOM 结构、markdown 语义、高亮、公式、尺寸）由应用拥有；
 * 颜色、背景与装饰由预设 CSS 通过 --qq-* 变量覆盖。
 * SVG foreignObject 是独立文档，拿不到应用里的 :root 变量，
 * 所以这里输出的是完整字面值，明暗两套都写在基线里。
 */
import { MASCOT_DATA_URI } from "./inline-assets";

export type CardTheme = "light" | "dark";

export interface CardPreset {
  id: string;
  label: string;
  builtin: boolean;
  /** 内置预设为空串表示完全使用基线；本地预设由后端返回拼好的 CSS。 */
  css: string;
}

type Tokens = {
  frame: string;
  card: string;
  border: string;
  shadow: string;
  title: string;
  body: string;
  muted: string;
  accent: string;
  badge: string;
  rule: string;
  codeBg: string;
  codeText: string;
  gutter: string;
  decor: string;
  tableLine: string;
};

const LIGHT: Tokens = {
  frame: "linear-gradient(135deg,#ece5ff 0%,#f7f4ff 42%,#e7dcff 100%)",
  card: "linear-gradient(165deg,#ffffff 0%,#fdfbff 52%,#f9f6ff 100%)",
  border: "rgba(124,92,232,.15)",
  shadow: "0 18px 46px rgba(92,64,170,.17)",
  title: "#43356f",
  body: "#494062",
  muted: "#8d859c",
  accent: "#7c5ce8",
  badge: "linear-gradient(135deg,#9d80f2,#7c5ce8)",
  rule: "linear-gradient(90deg,#b9a2f0 0%,rgba(185,162,240,0) 100%)",
  codeBg: "#f4f1ff",
  codeText: "#4a3b78",
  gutter: "#b8afc9",
  decor: "#d8ccf5",
  tableLine: "rgba(124,92,232,.16)",
};

const DARK: Tokens = {
  frame: "linear-gradient(135deg,#2b2442 0%,#1e1b2c 46%,#2e2649 100%)",
  card: "linear-gradient(165deg,#22202e 0%,#1c1a26 58%,#242134 100%)",
  border: "rgba(167,139,250,.2)",
  shadow: "0 18px 46px rgba(0,0,0,.45)",
  title: "#eae3ff",
  body: "#d7d1e5",
  muted: "#9d96af",
  accent: "#a78bfa",
  badge: "linear-gradient(135deg,#a78bfa,#8b6fe8)",
  rule: "linear-gradient(90deg,#8b6fe8 0%,rgba(139,111,232,0) 100%)",
  codeBg: "#2a2740",
  codeText: "#e2dcff",
  gutter: "#6f6884",
  decor: "#3d3357",
  tableLine: "rgba(167,139,250,.2)",
};

// 装饰保留原有造型；颜色占位符在生成基线时替换成主题字面色值。
// SVG presentation attribute 不支持 var()，所以不能把 var() 留在这里。
const TOP_DECOR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 290 150" aria-hidden="true">
<g fill="none" stroke="var(--qq-decor)" stroke-width="2" stroke-linecap="round">
<path d="M6 144C70 130 122 106 178 42"/><path d="M38 146C116 138 190 110 284 44"/><path d="M118 132C176 124 226 104 272 70"/>
</g>
<g fill="var(--qq-decor)" opacity=".85">
<g transform="translate(178,42)"><ellipse cx="0" cy="-10" rx="5.5" ry="10"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(72)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(144)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(216)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(288)"/></g>
<g transform="translate(244,72)" opacity=".8"><ellipse cx="0" cy="-8" rx="4.5" ry="8"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(72)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(144)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(216)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(288)"/></g>
<g transform="translate(284,44)" opacity=".7"><ellipse cx="0" cy="-7" rx="4" ry="7"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(72)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(144)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(216)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(288)"/></g>
</g></svg>`;

// 波浪必须铺满卡片全宽。原先固定 430px，右侧留下断层。
const BOTTOM_DECOR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 130" preserveAspectRatio="none" aria-hidden="true">
<path d="M0 130V88C40 58 80 66 118 92C160 120 200 96 240 78C300 52 360 70 430 92C490 110 550 78 620 72C680 66 720 90 760 84V130Z" fill="var(--qq-decor)" opacity=".42"/>
<path d="M0 130V104C60 84 100 104 150 118C210 134 280 108 340 106C400 104 450 122 520 116C590 110 650 100 700 112C730 118 748 112 760 116V130Z" fill="var(--qq-decor)" opacity=".28"/>
<path d="M76 58l6 16 16 6-16 6-6 16-6-16-16-6 16-6z" fill="#fff" opacity=".9"/>
<path d="M470 96l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#fff" opacity=".75"/>
</svg>`;

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

function tokenBlock(selector: string, t: Tokens, top: string, bottom: string): string {
  return `${selector}{
--qq-frame-bg:${t.frame};
--qq-card-bg:${t.card};
--qq-border:${t.border};
--qq-shadow:${t.shadow};
--qq-title:${t.title};
--qq-body:${t.body};
--qq-muted:${t.muted};
--qq-accent:${t.accent};
--qq-badge:${t.badge};
--qq-rule:${t.rule};
--qq-code-bg:${t.codeBg};
--qq-code-text:${t.codeText};
--qq-gutter:${t.gutter};
--qq-table-line:${t.tableLine};
--qq-frame-pad:20px;
--qq-frame-radius:42px;
--qq-card-radius:30px;
--qq-decor-top-image:${top};
--qq-decor-bottom-image:${bottom};
}`;
}

const paint = (svg: string, color: string) => svg.replace(/var\(--qq-decor\)/g, color);

const CLASSIC_TOKENS =
  tokenBlock(
    ".qq-frame",
    LIGHT,
    svgUrl(paint(TOP_DECOR, LIGHT.decor)),
    svgUrl(paint(BOTTOM_DECOR, LIGHT.decor)),
  ) +
  "\n" +
  tokenBlock(
    '.qq-frame[data-qq-theme="dark"]',
    DARK,
    svgUrl(paint(TOP_DECOR, DARK.decor)),
    svgUrl(paint(BOTTOM_DECOR, DARK.decor)),
  ) +
  `\n.qq-frame{--qq-mascot-image:url("${MASCOT_DATA_URI}")}`;

/** 所有预设共享的固定样式骨架。变量取值由 CLASSIC_TOKENS 提供基线。 */
export const BASE_CARD_CSS = `${CLASSIC_TOKENS}
*{box-sizing:border-box}
body{margin:0}
.qq-frame{
  width:800px;padding:var(--qq-frame-pad);border-radius:var(--qq-frame-radius);
  background:var(--qq-frame-bg);
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  color:var(--qq-body);
}
.qq-card{
  position:relative;overflow:hidden;width:100%;border-radius:var(--qq-card-radius);
  padding:46px 48px 150px;background:var(--qq-card-bg);
  border:1px solid var(--qq-border);box-shadow:var(--qq-shadow);
}
.qq-content{position:relative;z-index:1;font-size:20px;line-height:1.75}
.qq-title{
  position:relative;margin:0 0 16px;padding-left:22px;
  font-size:40px;line-height:1.34;font-weight:700;color:var(--qq-title);
  letter-spacing:.4px;white-space:pre-wrap;word-break:break-word;
}
.qq-title::before{
  content:"";position:absolute;left:0;top:8px;bottom:8px;width:9px;
  border-radius:5px;background:var(--qq-badge);
}
.qq-content>.qq-title+p{margin-top:2px;color:var(--qq-muted);font-size:21px}
.qq-content p{margin:10px 0}
.qq-content strong{color:var(--qq-title);font-weight:700}
.qq-content :not(pre)>code{
  padding:2px 6px;border-radius:5px;background:var(--qq-code-bg);
  color:var(--qq-code-text);font:17px/1.5 Consolas,"SF Mono",monospace;
}
.qq-content a{color:var(--qq-accent);text-decoration:none}
.qq-content ul,.qq-content ol{padding-left:30px;margin:12px 0}
.qq-content li{margin:4px 0}
.qq-content hr{border:none;border-top:2px solid var(--qq-border);margin:26px 0}
.qq-content table{border-collapse:collapse;width:100%;margin:16px 0;font-size:18px}
.qq-content th,.qq-content td{border:1px solid var(--qq-table-line);padding:8px 12px;text-align:left}
.qq-content th{background:var(--qq-code-bg);color:var(--qq-title);font-weight:700}
.qq-section{display:flex;align-items:center;gap:16px;margin:34px 0 16px}
.qq-section-no{
  flex:none;width:42px;height:42px;border-radius:11px;background:var(--qq-badge);
  color:#fff;font-size:23px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
}
.qq-section-title{flex:none;font-size:25px;font-weight:700;color:var(--qq-title)}
.qq-section-rule{flex:1;height:2px;background:var(--qq-rule)}
.qq-heading1{
  margin:30px 0 14px;font-size:28px;font-weight:700;color:var(--qq-title);line-height:1.5;
}
.qq-subhead{
  margin:26px 0 10px;padding-left:17px;border-left:6px solid var(--qq-accent);
  font-size:22px;font-weight:700;color:var(--qq-title);line-height:1.5;
}
.qq-quote{
  margin:14px 0;padding:3px 0 3px 18px;border-left:6px solid var(--qq-accent);
  font-size:21px;font-weight:600;color:var(--qq-body);
}
.qq-quote p{margin:0}
.qq-code{
  margin:20px 0 26px;padding:20px 26px;
  border-radius:18px;background:var(--qq-code-bg);
}
.qq-code-line{display:flex;align-items:flex-start;font:18px/1.7 Consolas,"SF Mono",monospace}
.qq-code-no{
  flex:none;width:36px;margin-right:18px;text-align:right;
  color:var(--qq-gutter);user-select:none;
}
.qq-code-text{
  flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--qq-code-text);
}
.katex-display{margin:18px 0;padding:16px 24px;border-radius:20px;background:var(--qq-code-bg);overflow:visible;font-size:1.24em}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-operator{color:var(--qq-accent);font-weight:600}
.hljs-string,.hljs-attr,.hljs-regexp,.hljs-addition{color:#16a34a}
.hljs-number,.hljs-symbol,.hljs-bullet{color:#ea8b0b}
.hljs-title,.hljs-title\\.function_,.hljs-built_in,.hljs-function{color:#3b82f6}
.hljs-comment,.hljs-quote,.hljs-deletion{color:var(--qq-gutter);font-style:italic}
.hljs-variable,.hljs-template-variable,.hljs-params{color:#db2777}
.hljs-type,.hljs-class .hljs-title,.hljs-tag{color:#0ea5e9}
.qq-decor-top{
  position:absolute;right:8px;top:26px;width:290px;height:150px;
  background-image:var(--qq-decor-top-image);
  background-repeat:no-repeat;background-size:contain;pointer-events:none;
}
.qq-decor-bottom{
  position:absolute;left:0;bottom:0;width:100%;height:130px;
  background-image:var(--qq-decor-bottom-image);
  background-repeat:no-repeat;background-size:100% 100%;pointer-events:none;
}
.qq-mascot{
  position:absolute;right:8px;bottom:-8px;width:270px;height:270px;
  background-image:var(--qq-mascot-image);
  background-repeat:no-repeat;background-size:contain;pointer-events:none;
}
`;

const PLAIN_CSS = `
.qq-frame{
  --qq-frame-bg:#f4f4f5;--qq-card-bg:#ffffff;--qq-frame-pad:16px;
  --qq-frame-radius:8px;--qq-card-radius:8px;--qq-border:#e4e4e7;
  --qq-shadow:none;--qq-title:#27272a;--qq-body:#3f3f46;--qq-muted:#71717a;
  --qq-accent:#52525b;--qq-badge:#a1a1aa;--qq-rule:#d4d4d8;
  --qq-code-bg:#f4f4f5;--qq-code-text:#3f3f46;--qq-gutter:#a1a1aa;
  --qq-table-line:#e4e4e7;
}
.qq-frame[data-qq-theme="dark"]{
  --qq-frame-bg:#18181b;--qq-card-bg:#1f1f23;--qq-border:#3f3f46;
  --qq-shadow:none;--qq-title:#f4f4f5;--qq-body:#e4e4e7;--qq-muted:#a1a1aa;
  --qq-accent:#d4d4d8;--qq-badge:#71717a;--qq-rule:#52525b;
  --qq-code-bg:#27272a;--qq-code-text:#e4e4e7;--qq-gutter:#71717a;
  --qq-table-line:#3f3f46;
}
.qq-decor-top,.qq-decor-bottom,.qq-mascot{display:none}
.qq-title::before{display:none}
.qq-title{padding-left:0}
.qq-code{border-radius:8px}
`;

export const BUILTIN_PRESETS: CardPreset[] = [
  { id: "classic", label: "经典", builtin: true, css: "" },
  { id: "plain", label: "朴素", builtin: true, css: PLAIN_CSS },
];

export function getBuiltinPreset(id: string): CardPreset | undefined {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}
