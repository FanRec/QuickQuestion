import { listCardPresets, loadCardPreset, openCardPresetsDir } from "./api";
import type { CardPresetInfo } from "./api";
import { BUILTIN_PRESET_META, isBuiltinPresetId } from "./card-preset-meta";

/** 内置与本地预设共用同一种元数据形状。 */
export type PresetInfo = CardPresetInfo;

/** 内置预设与本地预设统一从这里列出；本地项由后端返回。 */
export async function listPresets(): Promise<PresetInfo[]> {
  const local = await listCardPresets();
  const builtins: PresetInfo[] = BUILTIN_PRESET_META.map((meta) => ({
    id: meta.id,
    label: meta.label,
    description: "内置样式",
  }));
  return [...builtins, ...local];
}

/**
 * 返回可直接追加到 BASE_CARD_CSS 之后的样式片段。
 * 内置走本地常量，本地走后端（后端负责把资源文件转成 data URI）。
 * card-css 含大体积内联资产，按需 import，避免进入主 bundle。
 */
export async function loadPresetCss(id: string): Promise<string> {
  if (isBuiltinPresetId(id)) {
    const { getBuiltinPreset } = await import("./card-css");
    return getBuiltinPreset(id)?.css ?? "";
  }
  return loadCardPreset(id);
}

/** 打开用户预设目录；目录不存在由后端创建。 */
export function openPresetsDir(): Promise<void> {
  return openCardPresetsDir();
}
