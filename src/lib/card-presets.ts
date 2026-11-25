import { listCardPresets, loadCardPreset, openCardPresetsDir } from "./api";
import type { CardPresetInfo } from "./api";
import { BUILTIN_PRESETS, getBuiltinPreset } from "./card-css";

/** 内置与本地预设共用同一种元数据形状。 */
export type PresetInfo = CardPresetInfo;

/** 内置预设与本地预设统一从这里列出；本地项由后端返回。 */
export async function listPresets(): Promise<PresetInfo[]> {
  const local = await listCardPresets();
  const builtins: PresetInfo[] = BUILTIN_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    description: "内置样式",
  }));
  return [...builtins, ...local];
}

/**
 * 返回可直接追加到 BASE_CARD_CSS 之后的样式片段。
 * 内置走本地常量，本地走后端（后端负责把资源文件转成 data URI）。
 */
export function loadPresetCss(id: string): Promise<string> {
  const builtin = getBuiltinPreset(id);
  if (builtin) return Promise.resolve(builtin.css);
  return loadCardPreset(id);
}

/** 打开用户预设目录；目录不存在由后端创建。 */
export function openPresetsDir(): Promise<void> {
  return openCardPresetsDir();
}
