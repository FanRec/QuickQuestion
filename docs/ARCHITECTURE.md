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
│  list_exchanges · list_sessions · create_session         │
│  active_session · remember_session · delete_session      │
│  get_exchange · delete_exchange · copy_markdown          │
│  save_temp_image · open_login_window · browser_status    │
│  get_settings · update_settings · ping                   │
└──────────────────────┬───────────────────────────────────┘
┌──────────────────────▼───────────────────────────────────┐
│  Rust 内核 (src-tauri/src/)                              │
│  cdp/        CDP WebSocket 客户端、注入脚本、流式轮询      │
│  browser/    Edge 启动/复用、端口探测、生命周期            │
│  store/      SQLite 仓储（Session / Exchange 单一数据源） │
│  config/     settings.json 读写                          │
│  commands/   IPC 实现，唯一编排层                         │
│  model/      Session / Exchange / BrowserStatus 领域类型 │
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
                             sessionId, injectPrompt, newSession})
  → commands::send_message:
      1. try_begin_send 抢占发送权（一个问答周期内拒绝第二次提交）
      2. ensure_cdp：浏览器没起就起（离屏窗口 + 专用 profile），
         CDP 连接死了就重连
      3. 会话决策：
         - newSession=true 或原会话无绑定 → 本地新建会话
         - 有绑定 → 网页导航到对应 chat，接续上下文
      4. cdp::send：
         a. apply_modes 同步「深度思考/智能搜索」开关（导航后 DOM 重建，必须后置）
         b. subscribe 先装订阅者再发送，防事件丢失
         c. 上传图片（DOM.setFileInputFiles）、写入输入框、派发 Enter
         d. 给现有 .ds-message 打标，记录发出的文本作为新回复的身份锚点
      5. spawn_reply_poller 每 250ms 读一次新回复：
         - 增量 → emit("qq://stream", {type:"delta", exchangeId, text})
         - 完成 = 网页停止生成（或出现免责声明）且文本静默 quiet_ms
         - 完成 → 落库 → emit done；失败 → emit error（kind=loginRequired 等）
      6. 前端按 exchangeId 认领本窗口/本实例的事件，全局广播互不串扰
```

前端拿到的 delta 是**全量替换**而非拼接：丢一次增量下一条自动补齐，简单可靠。

## 4. 模块边界与依赖方向

- `commands/` 依赖 `cdp/`、`browser/`、`store/`、`config/`、`model/`
- `cdp/` 依赖 `model/`；**不依赖** `store/`（CDP 只负责网页交互）
- `browser/`、`store/`、`config/` 依赖 `model/` 或 `error/`
- 依赖单向，无环。`commands/` 是唯一编排层。

## 5. 窗口通信

- 窗口间不直接通信，统一经 Rust 中转：前端 A `invoke` → Rust `emit` → 前端 B `listen`。
- 事件命名 `qq://` 前缀：`stream`（delta/done/error）、`active`（网页当前会话）、
  `refresh`（数据已变，请重载）、`select`（定位某条问答）、`hotkey-input`、`settings-changed`。
- 后端事件是全局广播：每个实例用 `pendingExchangeIdRef` 只认自己发起的那一轮。

## 6. 设计令牌（src/styles/tokens.css）

唯一视觉事实源，组件只消费 CSS 变量，换肤不改组件：
品牌紫主色 + 语义色（success/danger）、中性色阶、表面色阶、R8/R12/R16 圆角、
S1–S3 阴影、160ms `cubic-bezier(.2,.8,.2,1)` 动效、明暗双主题（`:root[data-theme]`）。

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
