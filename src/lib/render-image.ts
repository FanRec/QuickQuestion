import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import hljs from "highlight.js/lib/common";
import { buildCardCss, cardDecorColor, type CardTheme } from "./card-css";
import { KATEX_CSS_INLINE, MASCOT_DATA_URI } from "./inline-assets";

const TOP_DECOR = `<svg class="qq-decor-top" viewBox="0 0 290 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g fill="none" stroke="var(--qq-decor)" stroke-width="2" stroke-linecap="round">
<path d="M6 144C70 130 122 106 178 42"/><path d="M38 146C116 138 190 110 284 44"/><path d="M118 132C176 124 226 104 272 70"/>
</g>
<g fill="var(--qq-decor)" opacity=".85">
<g transform="translate(178,42)"><ellipse cx="0" cy="-10" rx="5.5" ry="10"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(72)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(144)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(216)"/><ellipse cx="0" cy="-10" rx="5.5" ry="10" transform="rotate(288)"/></g>
<g transform="translate(244,72)" opacity=".8"><ellipse cx="0" cy="-8" rx="4.5" ry="8"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(72)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(144)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(216)"/><ellipse cx="0" cy="-8" rx="4.5" ry="8" transform="rotate(288)"/></g>
<g transform="translate(284,44)" opacity=".7"><ellipse cx="0" cy="-7" rx="4" ry="7"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(72)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(144)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(216)"/><ellipse cx="0" cy="-7" rx="4" ry="7" transform="rotate(288)"/></g>
</g></svg>`;

// 波浪必须铺满卡片全宽（760px）。原先固定 430px，右侧留下断层。
// 吉祥物在 DOM 中排在波浪之后、层级更高，会自然叠在连续波浪上。
const BOTTOM_DECOR = `<svg class="qq-decor-bottom" viewBox="0 0 760 130" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" aria-hidden="true">
<path d="M0 130V88C40 58 80 66 118 92C160 120 200 96 240 78C300 52 360 70 430 92C490 110 550 78 620 72C680 66 720 90 760 84V130Z" fill="var(--qq-decor)" opacity=".42"/>
<path d="M0 130V104C60 84 100 104 150 118C210 134 280 108 340 106C400 104 450 122 520 116C590 110 650 100 700 112C730 118 748 112 760 116V130Z" fill="var(--qq-decor)" opacity=".28"/>
<path d="M76 58l6 16 16 6-16 6-6 16-6-16-16-6 16-6z" fill="#fff" opacity=".9"/>
<path d="M470 96l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#fff" opacity=".75"/>
</svg>`;

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(katex, { output: "html" });

type CardEnv = { sectionNo: number };

md.renderer.rules.heading_open = (tokens, idx, _options, env) => {
  const tag = tokens[idx].tag;
  if (tag === "h2") {
    const state = env as CardEnv;
    state.sectionNo += 1;
    return `<div class="qq-section"><span class="qq-section-no">${state.sectionNo}</span><span class="qq-section-title">`;
  }
  // 回答里的 # 与问题主标题同级语义，用独立类避免混淆；h3~h6 统一为小节。
  if (tag === "h1") return '<div class="qq-heading1">';
  if (tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return '<div class="qq-subhead">';
  return "";
};

md.renderer.rules.heading_close = (tokens, idx) => {
  const tag = tokens[idx].tag;
  if (tag === "h2") return '</span><span class="qq-section-rule"></span></div>';
  if (tag === "h1" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "</div>";
  return "";
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const code = token.content.replace(/\n$/, "");
  // 行号与代码放在同一 flex 行：pre-wrap 折行时行号固定在行首，不会与后续行错位。
  // 逐行高亮，避免按字符串切行把 hljs 的 <span> 标签切断。
  const lines = code.split("\n");
  const rows = lines
    .map((line, i) => {
      let html: string;
      try {
        html = lang && hljs.getLanguage(lang)
          ? hljs.highlight(line, { language: lang, ignoreIllegals: true }).value
          : escapeText(line);
      } catch {
        html = escapeText(line);
      }
      return `<div class="qq-code-line"><span class="qq-code-no">${i + 1}</span><span class="qq-code-text">${html || "&nbsp;"}</span></div>`;
    })
    .join("");
  return `<div class="qq-code">${rows}</div>`;
};

md.renderer.rules.blockquote_open = () => '<blockquote class="qq-quote">';
md.renderer.rules.blockquote_close = () => "</blockquote>";

export interface RenderedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * 把问答渲染成贴片 PNG。字体与吉祥物已 data URI 内联，整张 SVG 自包含，
 * 因此 drawn canvas 不会被跨域资源污染，toBlob 可用。
 */
export async function markdownToPng(
  question: string,
  answer: string,
  theme: CardTheme,
): Promise<RenderedImage> {
  const env: CardEnv = { sectionNo: 0 };
  const answerHtml = md.render(answer, env);
  const title = escapeText(question.trim() || "[图片]");
  const decor = cardDecorColor(theme);
  const fillDecor = (svg: string) => svg.replace(/var\(--qq-decor\)/g, decor);
  const topDecor = fillDecor(TOP_DECOR);
  const bottomDecor = fillDecor(BOTTOM_DECOR);
  const bodyHtml =
    '<div class="qq-frame"><div class="qq-card">' +
    `<div class="qq-content"><h1 class="qq-title">${title}</h1>${answerHtml}</div>` +
    topDecor + bottomDecor +
    `<img class="qq-mascot" src="${MASCOT_DATA_URI}" alt="">` +
    "</div></div>";

  const css = buildCardCss(theme) + "\n" + KATEX_CSS_INLINE;
  // 样式必须放进 shadow root 隔离：<style> 挂在 document.body 下会全局生效，
  // 卡片的 * / body / .katex-display 规则会污染主窗口（点击瞬间闪一下）。
  // shadow 内的样式只作用于影子树，XMLSerializer 序列化 holder 仍带上完整 CSS。
  const holder = document.createElement("div");
  holder.innerHTML = `<style>${css}</style>${bodyHtml}`;
  const offscreen = document.createElement("div");
  offscreen.style.cssText =
    "position:fixed;left:-20000px;top:0;width:800px;visibility:hidden;pointer-events:none";
  offscreen.attachShadow({ mode: "open" }).appendChild(holder);
  document.body.appendChild(offscreen);

  try {
    await document.fonts.ready;
    const frame = holder.querySelector(".qq-frame") as HTMLElement | null;
    if (!frame) throw new Error("贴片结构生成失败");
    const width = Math.ceil(frame.getBoundingClientRect().width);
    const height = Math.ceil(frame.getBoundingClientRect().height);
    if (height > 8000) throw new Error("内容过长，请在主窗口阅读");

    const xhtml = new XMLSerializer().serializeToString(holder);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    // 必须用 data URL：blob URL 加载的 SVG-as-image 会污染 canvas，toBlob 抛 SecurityError。
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("贴片渲染失败"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.drawImage(img, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 编码失败"))), "image/png");
    });
    return { bytes: new Uint8Array(await png.arrayBuffer()), width, height };
  } finally {
    offscreen.remove();
  }
}
