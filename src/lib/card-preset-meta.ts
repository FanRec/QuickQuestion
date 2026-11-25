/**
 * 内置预设的轻量元数据。刻意不 import card-css.ts：
 * 后者内联了字体与吉祥物（约 483KB），只能在真正渲染贴片时加载。
 */
export interface CardPresetMeta {
  id: string;
  label: string;
}

/** id 与 src-tauri/src/card_presets.rs 的 RESERVED_IDS 必须一致。 */
export const BUILTIN_PRESET_META: readonly CardPresetMeta[] = [
  { id: "classic", label: "经典" },
  { id: "plain", label: "朴素" },
];

export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_PRESET_META.some((p) => p.id === id);
}
