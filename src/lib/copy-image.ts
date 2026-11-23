import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import type { CardTheme } from "./card-css";
import { listExchanges } from "./api";
import type { RenderedImage } from "./render-image";

/** 三处入口共用：取问答原文 → 按当前 App 主题渲染贴片 → 图片写入剪贴板。 */
export async function copyAsImage(id: string): Promise<RenderedImage> {
  const exchanges = await listExchanges();
  const exchange = exchanges.find((item) => item.id === id);
  if (!exchange) throw new Error("未找到该问答。");
  const theme: CardTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  // 渲染模块含 483KB 字体内联和语法高亮表，只在真正贴图时才加载。
  const { markdownToPng } = await import("./render-image");
  const image = await markdownToPng(exchange.questionText, exchange.answerText, theme);
  await writeImage(image.bytes);
  return image;
}
