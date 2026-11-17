# QuickQuestion 架构设计

## 1. 分层

```
┌─ 前端窗口层 (React + TS) ───────────────────────────────┐
│  orb     悬浮球：主球 + 小球，透明置顶无边框            │
│  chat    聊天栏：单输入框 + 上方流式气泡                │
│  history 悬浮列表：问答摘要 + 双按钮                    │
│  main    主窗口：左列表 / 右详情 + 标题栏菜单           │
└──────────────────────┬───────────────────────────────────┘
                       │ invoke / event（类型化边界）
┌──────────────────────▼───────────────────────────────────┐
│  Tauri IPC 命令层                                        │
│  send_message · cancel_message · list_exchanges          │
│  get_exchange · delete_exchange · copy_markdown          │
│  get_settings · update_settings · browser_status         │
└──────────────────────┬───────────────────────────────────┘
┌──────────────────────▼───────────────────────────────────┐
│  Rust 内核 (src-tauri/src/)                              │
│  cdp/        CDP WebSocket 客户端、注入脚本、流式事件    │
│  browser/    Edge 启动/复用、端口探测、生命周期          │
│  store/      SQLite 仓储（Exchange 单一数据源）          │
│  commands/   IPC 实现，编排 cdp + store                  │
│  model/      Exchange / Settings 领域类型                │
└──────────────────────┬───────────────────────────────────┘
                       │ CDP WebSocket / 文件 IO
┌──────────────────────▼───────────────────────────────────┐
│  外部系统：Edge(DeepSeek 网页) · SQLite 文件 · 剪贴板    │
└──────────────────────────────────────────────────────────┘
```

## 2. 领域模型

```rust
struct Exchange {
    id: String,              // uuid
    created_at: i64,         // unix ms
    question: Question,
    answer: String,
    status: ExchangeStatus,  // Complete | Error
}

struct Question {
    text: String,
    images: Vec<ImageRef>,
}

struct ImageRef {
    id: String,
    path: String,            // 本地落盘路径
    name: String,
}
```

复制格式（M4 实现）：`## {question.text}\n{answer}`，图片按出现顺序替换为 `[图片1]`、`[图片2]`。

## 3. 数据流：发送一条消息

```
前端 chat 输入框回车
  → invoke("send_message", {text, images})
  → commands::send_message:
      1. 创建 Exchange(status=Streaming) 写入 SQLite，返回 id
      2. browser::ensure_ready() —— 确保 Edge 已启动并登陆 DeepSeek
      3. cdp::send(text, images):
         a. DOM.setFileInputFiles 上传图片（若有）
         b. Runtime.evaluate 写入输入框 + 派发 input 事件
         c. 派发 Enter
         d. 注入 MutationObserver 监听回复容器
      4. observer 每次增量 → emit("stream-delta", {id, delta})
      5. 完成状态机确认 → emit("stream-done", {id})
      6. 更新 Exchange.answer / status = Complete 落库
  → 前端 chat 气泡逐块追加；history/main 收到事件后从 SQLite 重载
```

## 4. 模块边界与依赖方向

- `commands/` 依赖 `cdp/`、`browser/`、`store/`、`model/`
- `cdp/` 依赖 `model/`；**不依赖** `store/`（CDP 只负责网页交互）
- `browser/` 依赖 `model/`（Settings 中的端口/profile）
- `store/` 依赖 `model/`；**不依赖** `cdp/`
- 依赖单向，无环。`commands/` 是唯一编排层。

## 5. 窗口通信

- 窗口间不直接通信，统一经 Rust 中转：前端 A `invoke` → Rust `emit` → 前端 B `listen`。
- 事件 envelope 统一为 `{ type, payload }`，避免散落的事件名。
- 当前视图只渲染自己需要的窗口；隐藏窗口保持挂载（避免反复初始化 WebView）。

## 6. 苹果风格设计系统（src/styles/tokens.css）

| Token | 浅色 | 深色 |
|---|---|---|
| `--surface` | `rgba(255,255,255,0.72)` | `rgba(28,28,30,0.72)` |
| `--surface-solid` | `#ffffff` | `#1c1c1e` |
| `--text-primary` | `#1d1d1f` | `#f5f5f7` |
| `--text-secondary` | `#86868b` | `#98989d` |
| `--accent` | `#007aff` | `#0a84ff` |
| `--blur` | `saturate(180%) blur(20px)` | 同 |
| `--radius-card` | `14px` | 同 |
| `--radius-bubble` | `18px` | 同 |
| `--shadow` | `0 8px 32px rgba(0,0,0,.12)` | `0 8px 32px rgba(0,0,0,.4)` |
| `--font` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif` | 同 |

字体只用 400 / 500 / 600 三档；动效 `cubic-bezier(.2,.8,.2,1)` 180ms；所有可点元素 hover/active 有明确反馈。

## 7. 失败路径（M6 完善，此处定义协议）

| 情形 | 检测 | 行为 |
|---|---|---|
| 未登录 | URL 含 login/sign_in 或输入框不存在 | emit 错误事件，冻结输入，提示"请在网页完成登录" |
| 验证码 | 页面文本含验证关键词 | 同上，提示人工处理 |
| 网页改版 | 输入框/回复容器探测失败 | 带诊断信息的错误事件，不静默 |
| 断连 | WebSocket 关闭 | BrowserManager 重连（最多 3 次），失败后上报 |
| 用户取消 | 前端 emit cancel | 中止当前 evaluate/observer，保留已收到的部分文本 |
