import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import katexCss from "katex/dist/katex.min.css?raw";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(katex);

/** 贴图片工具（如 Snipaste）会把剪贴板里的 HTML 渲染成图片，所以样式必须自带。 */
const BASE_CSS = `
body{margin:0;padding:14px 18px;background:#fff;color:#1a1a1a;
  font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1,h2,h3,h4{margin:16px 0 8px;font-weight:600;line-height:1.4}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}h4{font-size:14px}
p{margin:0 0 12px}
ul,ol{padding-left:24px;margin:0 0 12px}
li{margin:2px 0}
pre{background:#f5f5f7;padding:12px 14px;border-radius:8px;overflow-x:auto;margin:12px 0}
code{font-family:Consolas,"SF Mono",monospace;font-size:12.5px}
:not(pre)>code{background:#f0f0f3;padding:2px 5px;border-radius:4px}
blockquote{border-left:3px solid #d0d0d5;padding-left:12px;color:#555;margin:12px 0}
table{border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #ddd;padding:6px 10px}
a{color:#0066cc}
hr{border:none;border-top:1px solid #e0e0e4;margin:16px 0}
.katex-display{margin:12px 0;overflow-x:auto;overflow-y:hidden;padding:2px 0}
`;

/** 把 markdown 源码渲染成自带样式的完整 HTML，用于富文本复制。 */
export function markdownToHtml(source: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>` +
    `<style>${BASE_CSS}\n${katexCss}</style>` +
    `<article>${md.render(source)}</article></body></html>`;
}
