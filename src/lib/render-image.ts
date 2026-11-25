import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import hljs from "highlight.js/lib/common";
import { BASE_CARD_CSS, type CardTheme } from "./card-css";
import { KATEX_CSS_INLINE } from "./inline-assets";

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
 * 把问答渲染成贴片 PNG。字体、吉祥物、装饰与预设资源都已内联，
 * 整张 SVG 自包含，drawn canvas 不会被跨域资源污染，toBlob 可用。
 * presetCss 是 resolvePresetCss 返回的完整样式片段（基线之后追加）。
 */
export async function markdownToPng(
  question: string,
  answer: string,
  theme: CardTheme,
  presetCss: string,
): Promise<RenderedImage> {
  const env: CardEnv = { sectionNo: 0 };
  const answerHtml = md.render(answer, env);
  const title = escapeText(question.trim() || "[图片]");
  const bodyHtml =
    `<div class="qq-frame" data-qq-theme="${theme}"><div class="qq-card">` +
    `<div class="qq-content"><h1 class="qq-title">${title}</h1>${answerHtml}</div>` +
    '<div class="qq-decor-top"></div><div class="qq-decor-bottom"></div><div class="qq-mascot"></div>' +
    "</div></div>";

  const css = BASE_CARD_CSS + "\n" + presetCss + "\n" + KATEX_CSS_INLINE;
  // 样式必须放进 shadow root 隔离：<style> 挂在 document.body 下会全局生效，
  // 卡片的 * / body / .katex-display 规则会污染主窗口（点击瞬间闪一下）。
  // 用户预设是外部文本，闭合标签要转义，否则会从 <style> 里逃出去。
  const holder = document.createElement("div");
  holder.innerHTML = `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>${bodyHtml}`;
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
