export type ThemeMode = "system" | "light" | "dark";

const KEY = "qq-theme";

export function loadTheme(): ThemeMode {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  paint(mode);
}

function paint(mode: ThemeMode) {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = mode === "dark" || (mode === "system" && systemDark);
  root.setAttribute("data-theme", dark ? "dark" : "light");
}

/// 跨窗口同步：localStorage 变化与系统主题变化都重新绘制。
export function watchTheme() {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) paint(loadTheme());
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (loadTheme() === "system") paint("system");
  });
}
