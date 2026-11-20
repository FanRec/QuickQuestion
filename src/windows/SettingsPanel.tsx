import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { browserStatus, errText, getSettings, updateSettings, type Settings } from "../lib/api";
import { applyTheme, loadTheme, type ThemeMode } from "../lib/theme";
import { emitSettingsChanged } from "../lib/events";
import "./SettingsPanel.css";

type SectionId = "login" | "prompt" | "appearance" | "hotkey" | "autohide" | "advanced";

const NAV: { id: SectionId; label: string }[] = [
  { id: "login", label: "登录状态" },
  { id: "prompt", label: "系统提示" },
  { id: "appearance", label: "外观" },
  { id: "hotkey", label: "唤起快捷键" },
  { id: "autohide", label: "自动消失" },
  { id: "advanced", label: "高级设置" },
];

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>({
    browserPort: 9222,
    quietMs: 900,
    systemPrompt: "",
    hotkey: "Alt+Q",
    lastSessionId: "",
    bubbleHideSecs: 5,
    popupHideSecs: 0,
  });
  const [theme, setTheme] = useState<ThemeMode>(loadTheme());
  const [saved, setSaved] = useState(false);
  const [loginInfo, setLoginInfo] = useState<string>("未检测");
  const [active, setActive] = useState<SectionId>("login");
  const scrollRef = useRef<HTMLDivElement>(null);

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
      if (!status.ready) {
        setLoginInfo("浏览器调试端口未连接，请检查浏览器是否可启动。");
        return;
      }
      const loggedIn = !status.needsLogin && status.inputReady;
      setLoginInfo(
        loggedIn
          ? "已登录，可以提问"
          : `未登录，请点击下方按钮打开浏览器完成登录（${status.loginReason || "状态未知"}）`,
      );
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

  // 左栏导航定位 + 滚动联动：右栏滚到哪一节，导航高亮跟到哪一节。
  const jumpTo = (id: SectionId) => {
    setActive(id);
    // 高级设置是折叠的 <details>：先展开再滚动，否则只滚到一行折叠标题。
    if (id === "advanced") {
      const details = scrollRef.current?.querySelector<HTMLDetailsElement>("#set-advanced");
      if (details) details.open = true;
    }
    scrollRef.current
      ?.querySelector(`#set-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    let current: SectionId = NAV[0].id;
    for (const item of NAV) {
      const el = root.querySelector(`#set-${item.id}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= 96) current = item.id;
    }
    setActive(current);
  };

  return (
    <div className="settings-panel">
      <aside className="settings-nav">
        <div className="settings-nav-title">设置</div>
        {NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`settings-nav-item${active === item.id ? " is-active" : ""}`}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="settings-main">
        <div className="settings-scroll" ref={scrollRef} onScroll={onScroll}>
          <section className="settings-group" id="set-login">
            <h3 className="settings-label">DeepSeek 登录状态</h3>
            <div className="login-check">
              <button type="button" className="settings-button" onClick={() => void checkLogin()}>
                检测登录状态
              </button>
              <button
                type="button"
                className="settings-button"
                onClick={() => {
                  void invoke("open_login_window").then(
                    () => setLoginInfo("已打开浏览器窗口，请在 DeepSeek 页面完成登录。"),
                    (e) => setLoginInfo(`打开登录窗口失败：${errText(e)}`),
                  );
                }}
              >
                打开登录窗口
              </button>
              <span className="settings-hint">{loginInfo}</span>
            </div>
          </section>

          <section className="settings-group" id="set-prompt">
            <h3 className="settings-label">系统提示</h3>
            <p className="settings-desc">
              让 DeepSeek 按你的习惯回答。只在该会话第一条提问前注入一次，不会反复占用上下文。
            </p>
            <textarea
              className="settings-textarea"
              rows={5}
              placeholder="例如：你是一名严谨的数学老师，回答时给出推导步骤，不要跳步。"
              value={settings.systemPrompt}
              onChange={(e) => change("systemPrompt", e.target.value)}
            />
          </section>

          <section className="settings-group" id="set-appearance">
            <h3 className="settings-label">外观</h3>
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

          <section className="settings-group" id="set-hotkey">
            <h3 className="settings-label">唤起快捷键</h3>
            <input
              type="text"
              className="settings-input"
              value={settings.hotkey}
              placeholder="Alt+Q"
              onChange={(e) => change("hotkey", e.target.value)}
            />
            <span className="settings-hint">格式如 Alt+Q、Ctrl+Shift+Q；修改后需重启应用生效</span>
          </section>

          <section className="settings-group" id="set-autohide">
            <h3 className="settings-label">自动消失</h3>
            <label className="settings-field">
              <span className="settings-field-label">回复气泡</span>
              <input
                type="number"
                className="settings-input settings-input--num"
                value={settings.bubbleHideSecs}
                min={0}
                max={600}
                onChange={(e) => change("bubbleHideSecs", Number(e.target.value))}
              />
              <span className="settings-field-unit">秒</span>
            </label>
            <span className="settings-hint">0 表示永不消失，需手动点 × 关闭</span>

            <label className="settings-field">
              <span className="settings-field-label">独立输入条（Alt+Q）</span>
              <input
                type="number"
                className="settings-input settings-input--num"
                value={settings.popupHideSecs}
                min={0}
                max={600}
                onChange={(e) => change("popupHideSecs", Number(e.target.value))}
              />
              <span className="settings-field-unit">秒</span>
            </label>
            <span className="settings-hint">空闲多少秒后整体收起，0 表示永不</span>
          </section>

          <details className="settings-group settings-advanced" id="set-advanced">
            <summary className="settings-label">高级设置</summary>
            <label className="settings-field settings-field--block">
              <span className="settings-field-label">浏览器调试端口</span>
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
            <label className="settings-field settings-field--block">
              <span className="settings-field-label">回复完成判定（毫秒）</span>
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
          </details>
        </div>

        <div className="settings-footer">
          <button type="button" className="settings-save" onClick={() => void save()}>
            {saved ? "已保存" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
