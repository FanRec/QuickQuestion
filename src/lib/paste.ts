import { invoke } from "@tauri-apps/api/core";
import { errText } from "./api";

/**
 * 粘贴内容里是否含图片文件。同步函数：调用方据此在事件派发结束前
 * preventDefault，挡掉浏览器默认粘贴（async 之后再调就晚了）。
 */
export function hasImageFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
}

/**
 * 从粘贴事件中提取图片并落盘，返回可上传的本地路径。
 * 单张失败不中断其余图片，失败原因收集在 errors 里由调用方自行展示。
 */
export async function savePastedImages(
  data: DataTransfer | null,
): Promise<{ paths: string[]; errors: string[] }> {
  const files = Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);

  const paths: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const ext = file.type.split("/")[1] || "png";
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      paths.push(await invoke<string>("save_temp_image", { bytes, ext }));
    } catch (err) {
      errors.push(`“${file.name || "图片"}”粘贴失败：${errText(err)}`);
    }
  }
  return { paths, errors };
}
