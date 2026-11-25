# QuickQuestion 架构设计

桌面悬浮球 AI 问答工具：通过 CDP 驱动用户自己的 Edge/Chrome 网页版 DeepSeek，
把提问和复制答案的步骤压到最短。所有数据只保存在本机。

## 1. 分层

```
┌─ 前端窗口层 (React + TS) ───────────────────────────────┐
│  panel    悬浮球：主球 + 小球，三态（球 / 内嵌输入条 / 历史）│
│  composer Alt+Q 独立输入条：同一 Composer 组件的另一实例    │
│  main     主窗口：会话树 / 搜索 / 详情 + 设置 + 帮助        │
└──────────────────────┬───────────────────────────────────┘
                       │ invoke / event（类型化边界）
┌──────────────────────▼───────────────────────────────────┐
│  Tauri IPC 命令层 (commands/)                            │
│  send_message · cancel_message · is_sending              │
│  list_exchanges · list_sessions · active_session         │
│  remember_session · switch_session · delete_session      │
│  delete_exchange · copy_markdown · save_temp_image       │
│  open_login_window · browser_status · get_settings       │
│  update_settings · list_card_presets · load_card_preset   │
│  open_card_presets_dir                                   │
└──────────────────────┬───────────────────────────────────┘
┌──────────────────────▼───────────────────────────────────┐
│  Rust 内核 (src-tauri/src/)                              │
│  cdp/        CDP WebSocket 客户端、注入脚本、流式轮询      │
│  browser/    Edge 启动/复用、端口探测、生命周期            │
│  store/      SQLite 仓储（Session / Exchange 单一数据源） │
│  config.rs   settings.json 读写                          │
│  card_presets.rs  用户贴图预设目录扫描与资源内联          │
│  commands/   IPC 实现，唯一编排层                         │
│  model.rs    Session / Exchange / BrowserStatus 领域类型 │
└──────────────────────┬───────────────────────────────────┘
                       │ CDP WebSocket / 文件 IO
┌──────────────────────▼───────────────────────────────────┐
│  外部系统：Edge(DeepSeek 网页) · SQLite 文件 · 剪贴板    │
└──────────────────────────────────────────────────────────┘
```

## 2. 领域模型

```rust
struct Session {
    id: String,              // uuid
    title: String,           // 首条问答前显示「新会话」，之后取问题前 28 字
    created_at: i64,         // unix ms
    updated_at: i64,
    deepseek_chat_id: String, // 对应网页会话 UUID；空表示未绑定
}

struct Exchange {
    id: String,              // uuid，与前端流式事件 key 一致
    session_id: String,
    created_at: i64,
    question_text: String,
    answer_text: String,
    image_names: Vec<String>, // 随问落盘的粘贴图片文件名
}
```

复制格式：`## {question_text}\n{answer_text}`，图片按顺序替换为 `[图片1]`、`[图片2]`。

## 3. 数据流：发送一条消息

```
前端输入框回车
  → invoke("send_message", {text, files, deepThink, webSearch,
                             sessionId, newSession})
  → commands::send_message:
      1. try_begin_send 抢占发送权（一个问答周期内拒绝第二次提交）
      2. ensure_cdp：浏览器没起就起（离屏窗口 + 专用 profile），
         CDP 连接死了就重连；随后 reset_cancel，使准备期内的打断都能生效
      3. 会话决策：
         - newSession=true 或原会话无绑定 → 本地新建会话
         - 有绑定 → 仅当网页不在目标 chat 时才导航，已在则跳过重载
      4. cdp::send：
         a. apply_modes 同步「深度思考/智能搜索」开关（导航后 DOM 重建，必须后置）
         b. subscribe 安装 mpsc 订阅者再发送，防事件丢失
         c. 上传图片（DOM.setFileInputFiles）、写入输入框
         d. 快照现有 .ds-message（位置标记 + 文本 + 最后一条答案），记下发出文本作为身份锚点，再派发 Enter
      5. spawn_reply_poller 每 80ms 读一次新回复：
         - 认锚点：发送后才能出现的用户消息里，文本含发出内容的那条；取其后第一个助手节点
         - 锚点未出现（或助手节点还没渲染）就继续等，不拿"最后一条未打标"顶替——
           那会先把上一条答案推给前端（闪旧答案）
         - 增量 → emit("qq://stream", {type:"delta", exchangeId, text})
         - 完成 = 生成停止且文本静默 quiet_ms；按钮状态卡住时由独立静默兜底
         - 完成 → 落库 → emit done；失败 → emit error（kind=loginRequired 等）
      6. 前端按 exchangeId 认领本窗口/本实例的事件，全局广播互不串扰
```

前端拿到的 delta 是**全量替换**而非拼接：丢一次增量下一条自动补齐，简单可靠。

### 3.1 会话指针与「接续」语义

三个指针职责固定，不再互相顶替（历史上"人在 B、内容是 A"就出在职责混淆）：

| 指针 | 含义 | 谁写 |
|---|---|---|
| `currentId` | 主窗口这条输入条的发送目标（用户意图焦点） | 左栏单击、搜索定位、发送成功、切换成功 |
| `selectedId` | 右栏展示哪一条问答 | 由 `currentId` 派生该会话最后一条 |
| `activeId` | 网页当前所在会话，只读投影 | `active_session` 命令、`qq://active` 事件 |

- **接续行 = 本输入条的发送目标**：主窗口按 `currentId` + 是否已绑定 `deepseek_chat_id` 派生（与后端 `send_inner` 的判断同源，未绑定时显示「未接续 · 发送将开启新会话」）；悬浮球/独立输入条没有会话列表，按 `activeId` 派生，因为那就是它的发送目标。
- **左栏单击只移动浏览焦点，不导航网页**：翻看历史不该每次整页重载。
- **右键「切换到该会话」是显式命令**：`switch_session` 真正导航网页并广播 `qq://active`，让网页位置、接续行与悬浮球发送目标一起收敛。回复进行中拒绝切换（导航会重建 DOM，正在轮询的回复会丢）。
- 未绑定网页会话的会话（历史迁移遗留）无法接续，后端发送时另建会话。

## 4. 模块边界与依赖方向

- `commands/` 依赖 `cdp/`、`browser/`、`store/`、`config/`、`model/`
- `cdp/` 依赖 `model/`；**不依赖** `store/`（CDP 只负责网页交互）
- `browser/`、`store/`、`config/` 依赖 `model/` 或 `error/`
- 依赖单向，无环。`commands/` 是唯一编排层。

## 5. 窗口通信

- 窗口间不直接通信，统一经 Rust 中转：前端 A `invoke` → Rust `emit` → 前端 B `listen`。
- 事件命名 `qq://` 前缀：`stream`（delta/done/error）、`active`（网页当前会话；
  发送成功后与手动切换后都会广播）、`refresh`（数据已变，请重载）、`select`（定位某条问答）、
  `hotkey-input`、`settings-changed`。
- 后端事件是全局广播：每个实例用 `pendingExchangeIdRef` 只认自己发起的那一轮。

## 6. 设计令牌（src/styles/tokens.css）

唯一视觉事实源，组件只消费 CSS 变量，换肤不改组件：
品牌紫主色 + 语义色（success/danger）、中性色阶、表面色阶、R8/R12/R16 圆角、
S1–S3 阴影、160ms `cubic-bezier(.2,.8,.2,1)` 动效、明暗双主题（`:root[data-theme]`）。

### 6.1 贴图样式预设

贴图是导出函数 `PNG = Render(content, theme, presetCss)`。骨架（DOM、markdown、高亮、公式、尺寸）由 `card-css.ts` 固定，预设只通过 `--qq-*` 变量覆盖外观；主题是正交轴，渲染时在 `.qq-frame` 上写 `data-qq-theme`，一份预设可带两套颜色。

预设来源两条，返回同一种 CSS 片段：内置的 `classic`/`plain` 在前端常量里（只有 id/label 的轻量元数据在 `card-preset-meta.ts`，重样式模块按需 import，避免内联资产进入主 bundle）；用户预设放在 `%LOCALAPPDATA%/QuickQuestion/card-presets/<id>/`，由 `card_presets.rs` 读取 `tokens.css` 并把约定资源文件转成 data URI 后返回。设置只存预设 id，不存 CSS——用户改文件后刷新即可生效，不产生第二份真相。预览卡片与真实贴图调用同一个 `markdownToPng`，所见即所得；预设加载失败显式报错，不静默回退。完整契约见 [CARD_PRESETS.md](CARD_PRESETS.md)。

## 7. 失败路径

| 情形 | 检测 | 行为 |
|---|---|---|
| 未登录 | LOGIN_STATE_JS：URL / 可见登录 UI / 输入框缺失，返回结构化原因 | 错误事件 `kind=loginRequired`，前端弹「去登录」按钮（不靠文案猜） |
| 会话中途过期 | 轮询中回复框消失且登录态为未登录 | 同上，立即中断本轮 |
| 验证码 | 页面文本含验证关键词 / captcha 节点 | 错误提示人工完成验证 |
| 网页改版 | 输入框/回复容器探测失败 | 带诊断信息的错误事件，不静默 |
| 断连 | WebSocket 关闭（alive=false） | 下次 ensure_cdp 自动重连；轮询中则报「连接已断开」 |
| 用户取消 | cancel_message 置取消标志 | 轮询任务停止本机接收（网页端无法强制停止生成），保留已收文本 |
| 超时 | 180s 未完成 | 「等待回复超时」错误事件 |
