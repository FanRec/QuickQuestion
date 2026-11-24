/**
 * 贴片专用样式。SVG foreignObject 是独立文档，拿不到应用里的 :root 变量，
 * 所以这里输出的是完整字面值，深浅两套。
 */
export type CardTheme = "light" | "dark";

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

/** SVG presentation attribute 不支持 var()，装饰需要拿到字面色值。 */
export function cardDecorColor(theme: CardTheme): string {
  return (theme === "dark" ? DARK : LIGHT).decor;
}

export function buildCardCss(theme: CardTheme): string {
  const t = theme === "dark" ? DARK : LIGHT;
  return `
*{box-sizing:border-box}
body{margin:0}
.qq-frame{
  width:800px;padding:20px;border-radius:42px;background:${t.frame};
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  color:${t.body};
}
.qq-card{
  position:relative;overflow:hidden;width:760px;border-radius:30px;
  padding:46px 48px 150px;background:${t.card};
  border:1px solid ${t.border};box-shadow:${t.shadow};
}
.qq-content{position:relative;z-index:1;font-size:20px;line-height:1.75}
.qq-title{
  position:relative;margin:0 0 16px;padding-left:22px;
  font-size:40px;line-height:1.34;font-weight:700;color:${t.title};
  letter-spacing:.4px;white-space:pre-wrap;word-break:break-word;
}
.qq-title::before{
  content:"";position:absolute;left:0;top:8px;bottom:8px;width:9px;
  border-radius:5px;background:${t.badge};
}
.qq-content>.qq-title+p{margin-top:2px;color:${t.muted};font-size:21px}
.qq-content p{margin:10px 0}
.qq-content strong{color:${t.title};font-weight:700}
.qq-content a{color:${t.accent};text-decoration:none}
.qq-content ul,.qq-content ol{padding-left:30px;margin:12px 0}
.qq-content li{margin:4px 0}
.qq-content hr{border:none;border-top:2px solid ${t.border};margin:26px 0}
.qq-content table{border-collapse:collapse;width:100%;margin:16px 0;font-size:18px}
.qq-content th,.qq-content td{border:1px solid ${t.tableLine};padding:8px 12px;text-align:left}
.qq-content th{background:${t.codeBg};color:${t.title};font-weight:700}
.qq-section{display:flex;align-items:center;gap:16px;margin:34px 0 16px}
.qq-section-no{
  flex:none;width:42px;height:42px;border-radius:11px;background:${t.badge};
  color:#fff;font-size:23px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
}
.qq-section-title{flex:none;font-size:25px;font-weight:700;color:${t.title}}
.qq-section-rule{flex:1;height:2px;background:${t.rule}}
.qq-heading1{
  margin:30px 0 14px;font-size:28px;font-weight:700;color:${t.title};line-height:1.5;
}
.qq-subhead{
  margin:26px 0 10px;padding-left:17px;border-left:6px solid ${t.accent};
  font-size:22px;font-weight:700;color:${t.title};line-height:1.5;
}
.qq-quote{
  margin:14px 0;padding:3px 0 3px 18px;border-left:6px solid ${t.accent};
  font-size:21px;font-weight:600;color:${t.body};
}
.qq-quote p{margin:0}
.qq-code{
  margin:20px 0 26px;padding:20px 26px;
  border-radius:18px;background:${t.codeBg};
}
.qq-code-line{display:flex;align-items:flex-start;font:18px/1.7 Consolas,"SF Mono",monospace}
.qq-code-no{
  flex:none;width:36px;margin-right:18px;text-align:right;
  color:${t.gutter};user-select:none;
}
.qq-code-text{
  flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;color:${t.codeText};
}
.katex-display{margin:18px 0;padding:16px 24px;border-radius:20px;background:${t.codeBg};overflow:visible;font-size:1.24em}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-operator{color:${t.accent};font-weight:600}
.hljs-string,.hljs-attr,.hljs-regexp,.hljs-addition{color:#16a34a}
.hljs-number,.hljs-symbol,.hljs-bullet{color:#ea8b0b}
.hljs-title,.hljs-title\.function_,.hljs-built_in,.hljs-function{color:#3b82f6}
.hljs-comment,.hljs-quote,.hljs-deletion{color:${t.gutter};font-style:italic}
.hljs-variable,.hljs-template-variable,.hljs-params{color:#db2777}
.hljs-type,.hljs-class .hljs-title,.hljs-tag{color:#0ea5e9}
.qq-decor-top{position:absolute;right:8px;top:26px;width:290px;pointer-events:none}
.qq-decor-bottom{position:absolute;left:0;bottom:0;width:100%;height:130px;pointer-events:none}
.qq-mascot{
  position:absolute;right:8px;bottom:-8px;width:270px;
  pointer-events:none;user-select:none;
}
`;
}
