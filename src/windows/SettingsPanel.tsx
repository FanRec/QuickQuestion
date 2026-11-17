import { useEffect, useState } from "react";
import { getSettings, updateSettings, type Settings } from "../lib/api";
import { applyTheme, loadTheme, type ThemeMode } from "../lib/theme";
import "./SettingsPanel.css";

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>({ browserPort: 9222, quietMs: 900 });
  const [theme, setTheme] = useState<ThemeMode>(loadTheme());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);

  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    try {
      await updateSettings(settings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      setSaved(false);
    }
  };

  const chooseTheme = (mode: ThemeMode) => {
    setTheme(mode);
    applyTheme(mode);
  };

  return (
    <div className="settings-panel">
      <h2 className="panel-heading">设置</h2>

      <section className="settings-group">
        <div className="settings-label">外观</div>
        <div className="theme-switch">
          {(["system", "light", "dark"] as ThemeMode[]).map((mode) => (
            <button
              type="button"
              key={mode}
              className={`theme-option ${theme === mode ? "is-active" : ""}`}
              onClick={() => chooseTheme(mode)}
            >
              {mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <label className="settings-field">
          <span className="settings-label">浏览器调试端口</span>
          <input
            type="number"
            className="settings-input"
            value={settings.browserPort}
            min={1024}
            max={65535}
            onChange={(e) => change("browserPort", Number(e.target.value))}
          />
          <span className="settings-hint">修改后需重启应用生效</span>
        </label>

        <label className="settings-field">
          <span className="settings-label">回复完成判定（毫秒）</span>
          <input
            type="number"
            className="settings-input"
            value={settings.quietMs}
            min={200}
            max={5000}
            step={100}
            onChange={(e) => change("quietMs", Number(e.target.value))}
          />
          <span className="settings-hint">回复速度慢可调大，默认 900</span>
        </label>
      </section>

      <div className="settings-footer">
        <button type="button" className="settings-save" onClick={() => void save()}>
          {saved ? "已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}
