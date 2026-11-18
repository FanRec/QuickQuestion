import { useEffect, useState } from "react";
import { browserStatus, errText, getSettings, updateSettings, type Settings } from "../lib/api";
import { applyTheme, loadTheme, type ThemeMode } from "../lib/theme";
import { emitSettingsChanged } from "../lib/events";
import "./SettingsPanel.css";

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>({
    browserPort: 9222,
    quietMs: 900,
    systemPrompt: "",
    hotkey: "Alt+Q",
    bubbleHideSecs: 5,
    popupHideSecs: 0,
  });
  const [theme, setTheme] = useState<ThemeMode>(loadTheme());
  const [saved, setSaved] = useState(false);
  const [loginInfo, setLoginInfo] = useState<string>("未检测");

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);

  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const checkLogin = async () => {
    try {
      const status = await browserStatus();
      const loggedIn = !status.pageUrl.includes("sign_in") && status.inputReady;
      setLoginInfo(loggedIn ? "已登录，可以提问" : "未登录，请在浏览器中登录后重试");
    } catch (e) {
      setLoginInfo(`检测失败：${errText(e)}`);
    }
  };

  const save = async () => {
    try {
      await updateSettings(settings);
      setSaved(true);
      // 立刻让已打开的输入条换用新配置，避免"设了没反应"。
      await emitSettingsChanged();
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
        <div className="settings-label">DeepSeek 登录状态</div>
        <div className="login-check">
          <button type="button" className="login-check-btn" onClick={() => void checkLogin()}>
            检测登录状态
          </button>
          <span className="settings-hint">{loginInfo}</span>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-label">系统提示词</div>
        <textarea
          className="settings-textarea"
          rows={4}
          placeholder="例如：你是一名严谨的数学老师，回答时给出推导步骤，不要跳步。"
          value={settings.systemPrompt}
          onChange={(e) => change("systemPrompt", e.target.value)}
        />
        <span className="settings-hint">
          只在每个会话的第一条提问前注入一次；留空则不注入。网页版没有真正的 system 角色，这是等效做法。
        </span>
      </section>

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
          <span className="settings-label">唤起快捷键</span>
          <input
            type="text"
            className="settings-input"
            value={settings.hotkey}
            placeholder="Alt+Q"
            onChange={(e) => change("hotkey", e.target.value)}
          />
          <span className="settings-hint">格式如 Alt+Q、Ctrl+Shift+Q；修改后需重启应用生效</span>
        </label>
      </section>

      <section className="settings-group">
        <div className="settings-label">自动消失</div>
        <label className="settings-field">
          <span className="settings-hint">回复气泡：0 秒表示永不消失</span>
          <input
            type="number"
            className="settings-input"
            value={settings.bubbleHideSecs}
            min={0}
            max={600}
            step={1}
            onChange={(e) => change("bubbleHideSecs", Number(e.target.value))}
          />
        </label>
        <label className="settings-field">
          <span className="settings-hint">独立输入条（Alt+Q）：空闲多少秒后整体收起，0 表示永不</span>
          <input
            type="number"
            className="settings-input"
            value={settings.popupHideSecs}
            min={0}
            max={600}
            step={1}
            onChange={(e) => change("popupHideSecs", Number(e.target.value))}
          />
        </label>
      </section>

      <details className="settings-advanced">
        <summary>高级设置</summary>
        <div className="settings-advanced-body">
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
        </div>
      </details>

      <div className="settings-footer">
        <button type="button" className="settings-save" onClick={() => void save()}>
          {saved ? "已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}
