# M1 详细设计 — 四窗口形态骨架

## 目标
让四个窗口从静态占位变为可交互的界面骨架：悬浮球可拖拽、聊天栏单输入框、悬浮列表、主窗口左右布局，全部苹果风格。**此里程碑仍不接 DeepSeek、不读数据库**，先用本地模拟数据验证交互与视觉，数据接入留到 M4。

## 前置修复（M0 审查遗留）
无。M0 已干净提交。

## 窗口交互状态机

四个窗口独立，但显隐由用户动作驱动。定义前端状态（存 Rust 侧更简单，但 M1 阶段先在前端各自管理，M4 接数据时再收敛）：

```
orb:
  主球 click     → show(chat)，并把 chat 定位到主球上方
  小球 click     → show(history)，定位到小球上方
  拖拽           → data-tauri-drag-region（系统级，无需 JS）

chat:
  显示后输入框 autofocus
  Esc / 失焦点击外部 → hide
  发送（M3 接入）    → 暂不实现

history:
  Esc / 失焦 → hide
  条目「展开」按钮（M4 接入）→ 暂用模拟数据占位
  条目「复制」按钮（M4 接入）→ 暂不实现

main:
  由 history 的展开按钮唤起（M4）
  普通标题栏，最小化/最大化/关闭用系统默认行为
```

## 各窗口几何与视觉

### orb（132×56，透明置顶）
- 已在 M0 实现主球+小球视觉，M1 补充：hover tooltip、点击 cursor 反馈。
- 窗口本身用 `data-tauri-drag-region` 覆盖背景；两个球是按钮，点击与拖拽共存（Tauri 的 drag-region 在按钮上会拦截 click，需验证；若冲突则给球单独区域，背景拖拽）。

### chat（420×240，透明置顶，M0 隐藏）
- 一个圆角玻璃卡片填满窗口：`var(--surface)` + blur + 0.5px border + `var(--radius-card)`。
- 卡片顶部一个极简标题「问点什么」+ 右侧关闭 ×（次要）。
- 中部：流式答案气泡容器（M3 填入），M1 为空态。
- 底部：单个输入框（圆角 `var(--radius-control)`，placeholder「输入问题，回车发送…」，图片按钮留位 M3）。
- 输入框 autofocus；回车触发 `onSubmit`（M1 仅 console + 本地气泡模拟）。

### history（340×480，透明置顶，M0 隐藏）
- 玻璃卡片 + 顶部标题「历史问答」+ 关闭 ×。
- 列表区：M1 用 3~5 条模拟 Exchange，每条显示问题摘要（单行省略）+ 时间 + 右侧两个图标按钮（展开、复制）。
- 按钮 M1 只做 hover 反馈，点击留空（M4 接入真实数据）。

### main（1080×680，普通窗口，M0 隐藏）
- 标准标题栏（系统 decorations），Apple 风格内容区。
- 左右布局：左栏 300px 问题列表（模拟数据），右栏 flex 显示完整问答（选中态高亮）。
- 顶部菜单条：文件/编辑/设置/帮助（M1 只做视觉与下拉占位，M5 接入功能）。
- M1 用模拟数据呈现选中联动（点左栏切换右栏内容）。

## 共享组件（新建 src/components/）
- `GlassCard.tsx`：统一玻璃卡片容器（背景、blur、border、圆角、阴影）。
- `IconButton.tsx`：统一图标按钮（hover/active 反馈、尺寸档位）。
- `mockData.ts`：模拟 Exchange 数据（M1 专用，M4 删除）。

## IPC / Rust 改动
M1 需要一个最小能力：前端点击主球/小球时显示对应窗口。用 Tauri 前端 API 即可（`getCurrentWindow()` + `show()`），无需 Rust 命令：
- `@tauri-apps/api/window` 的 `WebviewWindow.getByLabel('chat')?.show()`。
- 需要 capability 权限：`core:window:allow-show`、`core:window:allow-hide`、`core:window:allow-set-focus`、`core:window:allow-set-position`。
- 更新 `capabilities/default.json` 增加这些权限。

## 验收清单
1. 启动应用，orb 显示主球+小球，可拖拽。
2. 点主球 → chat 显示，输入框 autofocus，输入文字回车 → 本地模拟气泡显示。
3. 点小球 → history 显示，模拟列表可滚动，条目两按钮有 hover 反馈。
4. main 可通过模拟入口唤起，左栏点击切换右栏内容，窗口最小化/最大化/关闭正常。
5. 全部窗口视觉符合苹果风格（毛玻璃/圆角/字体/动效）。
6. `npm run build` + `cargo check` 通过。
7. 代码审查与重构后 git commit。

## 审查关注点
- 窗口显隐逻辑是否散落（应集中在各 window 组件，不重复）。
- 模拟数据与真实数据接口是否同形（M4 能平滑替换）。
- 苹果风格是否只用 tokens，不散写颜色。
- Esc 关闭、失焦处理是否一致。
