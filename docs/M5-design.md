# M5 详细设计 — 设置、帮助与常规窗口控件

## 目标
补齐主窗口的"普通软件"形态：设置面板、帮助面板、标准窗口控件（最小化/最大化/关闭）、系统托盘。坚持最小有用集，不做无实际用途的开关。

## 设置项（只做真正有用的）
| 项 | 用途 | 默认值 |
|---|---|---|
| 浏览器调试端口 | CDP 连接端口；冲突时可改 | 9222 |
| 主题 | 跟随系统 / 浅色 / 深色 | 跟随系统 |
| 流式静默窗口(ms) | 完成判定灵敏度；回复慢可加大 | 900 |

> 不做：API Key（走网页版，无需）、模型选择（网页端控制）、开机自启（收益低、实现重）。

**主题实现**：前端写 `data-theme` 到 `<html>`，tokens.css 增加 `[data-theme="light"]` / `[data-theme="dark"]` 覆盖；"跟随系统"用 `matchMedia`。设置持久化到 localStorage（主题是纯前端表现，无需入 DB）。

**端口/静默窗口持久化**：写入 `%APPDATA%/QuickQuestion/settings.json`（Rust 侧 ConfigService）。改端口需重启浏览器才生效——设置里明确提示。

## 帮助面板
纯静态内容：使用说明（主球/小球/复制格式）、快捷键、关于、免责声明（网页版 CDP 的 ToS/风控风险）。放在主窗口的一个 tab 或独立小窗口；M5 用主窗口内的模态面板实现（不新增窗口）。

## 常规窗口控件
- 主窗口 `decorations: true`，系统自带最小化/最大化/关闭（Tauri 默认行为，无需代码）。
- 菜单条「设置」「帮助」点击后切换主窗口内容区面板（列表/设置/帮助三态）。
- orb/chat/history 是透明无边框窗口，保持现状（关闭=hide）。
- 托盘图标：左键点击显示 orb，右键菜单「显示悬浮球 / 打开主窗口 / 退出」。

## 模块改动
- Rust：新增 `config.rs`（Settings 读写 JSON）；commands `get_settings` / `update_settings`；托盘在 lib.rs 用 `tauri::tray::TrayIconBuilder`。
- 前端：`SettingsPanel.tsx`、`HelpPanel.tsx`、`main-panel` 状态切换；`lib/api.ts` 加设置命令。
- 依赖：`tauri-plugin-tray`（或用 tauri 内置 tray；Tauri 2 内置 `tauri::tray`，无需插件）。

## 验收清单
1. `cargo check` + `npm run build` 通过。
2. 设置修改后重启应用仍生效（端口/主题/静默窗口）。
3. 主窗口三个面板（列表/设置/帮助）切换正常；窗口最小化/最大化/关闭正常。
4. 托盘菜单三项工作正常。
5. 代码审查与重构后 git commit。

## 实现期修正（源码实证）
1. **托盘需 feature flag**：Tauri 2 的 `tauri::tray` 需 Cargo 开启 `tray-icon` 特性，否则 E0432。
2. **on_exit 不可用**：当前 Tauri 版本 Builder 无 `on_exit`；改为在托盘「退出」菜单里显式调用 `browser.shutdown()`。
   普通关闭主窗口不退出应用（符合常驻工具预期），浏览器由 OS 回收（M2 已证）。
3. **主题实现**：从 `prefers-color-scheme` 媒体查询改为 `[data-theme]` 属性 + JS 在启动时设置；
   这样运行时切换与跨窗口同步（storage 事件）才生效。
4. **设置生效范围**：端口改后需重启应用；quiet_ms 即时生效（send_message 每次读取 config）。

## 运行时验证
- `npm run tauri dev` 启动成功，进程常驻无报错；托盘菜单与三窗口正常。
- 应用重启后自动复用已登录 profile（日志显示 DevTools 端口就绪），印证登录态持久化设计。

## 已知遗留（登记 M6）
- 主窗口左栏不监听 `qq://refresh`，打开期间新问答不自动出现（M4 已登记，M6 统一处理）。

## 审查关注点
- 设置读写失败不应导致应用崩溃（有默认值兜底）。
- 主题切换不引起窗口尺寸抖动。
- 托盘退出要回收浏览器进程（顺带解决 M2 遗留的 shutdown 问题）。
