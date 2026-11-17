# M3 详细设计 — 消息发送与 MutationObserver 流式回传

## 目标
打通端到端：前端输入文字 → CDP 写入 DeepSeek 输入框并发送 → MutationObserver 逐块捕获回复 → 通过 Tauri event 流式推回前端临时气泡 → 完成判定 → 落库（落库接口 M4 实现，M3 先用内存占位）。图片上传（DOM.setFileInputFiles）一并实现。

## 关键设计决策

### 1. 注入脚本常驻而非轮询
参考项目的 300ms 轮询拿不到真流式。本方案在页面注入一个 MutationObserver，监听回复容器，每次 DOM 增量就把**当前完整文本**写回 `window.__qqState.text`，并通过 CDP 的 `Runtime.consoleAPICalled` 或直接由前端发命令拉取。
- **取舍**：CDP 没有"页面主动推事件给 Rust"的便捷通道（除非用 `ExposedFunction` binding）。采用 **`Runtime.addBinding` + `Runtime.bindingCalled` 事件**：注入 JS 调用 `window.__qq_emit(delta)`，Rust 接收 `bindingCalled` 事件解析 delta。这是页面→Rust 的原生推送通道，比轮询高效。
- 需在 cdp 接收循环中处理 `method == "Runtime.bindingCalled"` 的事件（当前循环只按 id 分发，M3 要扩展：事件走独立回调）。

### 2. 完成状态机
观察停止生成控件的出现/消失（参考项目思路 + 社区四态机）：
- 等待 → 生成中（出现停止按钮）→ 候选完成（停止按钮消失，记静默起点）→ 确认完成（静默窗口 700ms 内文本不变）。
- 注入 JS 内维护，通过 `__qq_emit({type:'delta'|'done', text})` 上报。

### 3. 发送流程（Rust cdp::send_message）
1. `Page.bringToFront` + 焦点模拟。
2. 图片：若 files 非空，`DOM.setFileInputFiles` 塞入 `input[type=file]`，等待上传。
3. 文字：注入 JS 用原生 value setter + 派发 input/change 事件写入输入框（兼容 contenteditable）。
4. 记录发送前的回复条数/文本，避免把上一轮回复当成新的。
5. 注入 MutationObserver + binding，派发 Enter。
6. 接收 `delta` 事件 → emit 到前端；收到 `done` → 落库并 emit 完成。
7. 超时 180s 保护；取消命令中止。

### 4. 事件协议（前端 listen）
统一 envelope：`{ type: "streamDelta" | "streamDone" | "streamError", exchangeId, text?, message? }`
- 事件名固定 `qq://stream`。
- 前端 chat 窗口订阅，逐块追加到临时气泡。

### 5. 图片上传
前端读文件为临时路径（Tauri dialog 选文件）→ 传给 `send_message` 的 `files: string[]` → Rust 用 `DOM.setFileInputFiles`。

## 模块改动
- `cdp/mod.rs`：接收循环扩展事件分发；新增 `send_message`、`install_observer`、`write_input`、`press_enter`、`upload_files`；binding 回调通过 `tokio::sync::mpsc` 通道暴露给命令层。
- `commands/mod.rs`：新增 `send_message(text, files)` 命令（异步，同步返回 exchangeId，流式走 event）；`cancel_message` 命令。
- `error.rs`：新增常见错误文案。
- 前端 `ChatWindow.tsx`：接 `qq://stream` 事件，替换 M1 的本地模拟；图片附件按钮（Tauri dialog open）。
- 前端 `lib/events.ts`：集中封装事件监听。

## 落库占位（M4 前）
M3 阶段 `Exchange` 落库用内存 `Mutex<Vec<Exchange>>` 占位，接口与 M4 的 SQLite 仓储一致（trait 化：`ExchangeStore`），M4 换实现不改命令层。为不过度设计，M3 直接在 commands 里用一个 `Arc<Mutex<Vec<Exchange>>>`，M4 替换时一并重构——**不引入 trait**（避免过度抽象）。

## 验收清单
1. `cargo check --tests` + `npm run build` 通过。
2. 需要真实登录的端到端测试标记为 `#[ignore]`：登录后发文字 → 观察 delta 事件连续到达 → done 事件 → 文本完整。
3. 未登录/验证码场景：返回明确中文错误，不静默超时。
4. 取消：能中止当前流。
5. 代码审查与重构后 git commit。

## 实现期修正（源码实证）
1. **订阅者单次消费问题**：初版 `take_stream_rx()` 只能取一次，第二条消息会失败。
   已重构为 `subscribe()`：每次 send_message 安装新的 mpsc 发送端到 CdpClient.subscriber，
   接收循环把 bindingCalled 事件转给当前订阅者；done/error 后 `unsubscribe()` 清理。
   支持无限次顺序问答。
2. **页面→Rust 通道**：采用 `Runtime.addBinding("__qq_emit")` + bindingCalled 事件，
   注入脚本用 `window.__qq_emit(JSON.stringify(...))` 推送 delta/done，非轮询。
3. **完成判定**：注入脚本内 quiet window 900ms（无新文本即判定完成），并在每次 delta 重置计时器。

## 已知遗留（登记）
- **取消发送**：M3 未实现 cancel_message 命令（设计文档列出但优先级低于主链路）。
  登记到 M6；当前用户关闭 chat 窗口不会中止网页端生成。
- **端到端真登录验证**：本环境无已登录的 DeepSeek 账号，流式全链路未做真人测试；
  单元/集成层面已验证 CDP 通道、事件结构、编译与构建。需在真实登录后手动验收。

## 审查关注点
- binding 事件回调的生命周期：observer 重复安装会累积监听，需在每次发送前解绑旧 binding。
- delta 文本用完整文本还是增量：协议传完整 text，前端做 diff 追加（简单可靠）。
- 发送前快照避免串台。
- JS 注入用 serde_json 转义字符串，防注入。
