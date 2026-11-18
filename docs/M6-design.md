# M6 详细设计 — 端到端联调、健壮性与验收

## 目标
收口所有登记遗留，补全失败路径提示，做完整验收清单，交付可用版本。

## 遗留项清单（来自各里程碑 design 文档）

| 来源 | 遗留 | 本里程碑处理 |
|---|---|---|
| M2 | 应用退出回收浏览器 | ✅ M5 已在托盘退出调用 shutdown；dev-stop 实测无残留。验证 release 关闭路径。 |
| M3 | cancel_message 未实现 | 实现取消：close chat 或按 Esc 时中止当前流 |
| M4 | 主窗口不监听 qq://refresh | 补监听，打开期间新问答自动进入左栏 |
| M4 | delete_exchange 未接 UI | 主窗口详情加「删除」按钮 |
| M5 | 设置面板无"检测登录状态" | 加登录状态检测按钮，调用 browser_status |

## 失败路径兜底（ARCHITECTURE.md §7 协议落地）

| 情形 | 检测 | 用户提示 |
|---|---|---|
| 未登录 | CDP send_message 查 sign_in | 已有中文错误；前端 chat 气泡显示 |
| 验证码 | 注入 JS 检测验证关键词 | 本里程碑加：send_message 前检测，返回明确错误 |
| 网页改版 | 输入框/回复容器探测失败 | 已有；错误文案提示"页面结构可能已变化" |
| 断连 | WebSocket 关闭 | 本里程碑加：ensure_cdp 检测客户端是否存活，失效则重连 |

## 取消机制设计
- CdpClient 增加 `cancel_current()`：清订阅者 + 注入 JS disconnect observer + 派发包发送无用的提交（避免页面继续生成，但无法真正停止网页生成——如实说明）。
- 命令 `cancel_message`：调用 cancel_current，emit `qq://stream {type:"error", message:"已取消"}`。
- 前端 chat 关闭/Esc 时调用 cancel_message（若有进行中的问答）。

**诚实边界**：网页端生成无法被 CDP 强制停止（除非模拟点击"停止生成"按钮）。本实现取消的是"本机接收流"，网页可能仍在生成。在帮助里如实说明。

## 断重重连设计
- CdpClient 连接关闭时接收循环退出；当前 ensure_cdp 复用失效客户端会静默失败。
- 加 `is_alive()`：检查 CDP 底层是否已断开（用一个 AtomicBool 标志，接收循环退出时置 false）。
- ensure_cdp：若客户端存在但 !is_alive，则丢弃重连。

## 验收清单（最终）
1. 构建：`npm run build` + `cargo test --lib` + `cargo check --tests` 全通过。
2. 端到端（真实登录环境）：发文字 → 流式显示 → 落库 → 悬浮列表出现 → 主窗口详情 → 复制格式正确。
3. 图片：选图发送 → 图片上传 → 复制含 [图片1] 占位。
4. 失败路径：未登录/取消/断连重连各验证一次。
5. 三视图联动：新问答在主窗口打开时自动刷新左栏。
6. 代码审查与重构后 git commit（最终提交）。

## 端到端测试发现的真实缺陷与修复（源码/日志实证）
1. **多标签页串页**：反复测试后浏览器积累了 3 个 DeepSeek 标签（`/a/chat/s/...` 与两个 `/`）。
   `find_page_socket` 取第一个匹配页，消息发到 A 页、回复出现在 B 页，导致 observer 收不到 delta（90s 超时）。
   修复：`find_page_socket` 收集所有 DeepSeek 页，**保留最后一个（最新），关闭其余**，
   确保单一确定页面。并在 connect 末尾轮询等待输入框可见（最多 20s），避免命中未加载页。
2. **测试并发**：两个 `#[ignore]` 测试默认并发操作同一浏览器，互斥。
   运行方式固定为 `cargo test --test cdp_kernel -- --ignored --test-threads=1`。
3. 这些是真实健壮性问题，非测试环境偶发；修复对实际应用（单页场景）同样有益。

## 审查关注点
- 取消与正常 done 的竞态（取消后不应再写库）。
- 重连不产生重复订阅者。
- 所有新增命令有类型化前端封装。
- 最终 README（可选）：若有价值，写一份简短使用说明。

## 审查后修复（2026-11-18）

对 M6 未提交改动做逐项审查，修掉三处缺陷。均为源码级证据，非推测。

### 1. 轮询判新逻辑错误（会 180s 超时）
原实现：
```rust
let mut last_count = before.0;
...
if count > last_count || (!text.is_empty() && text != before.1) { saw_new = true; }
...
last_count = count;   // 每轮覆盖
```
`last_count` 每轮被覆盖成当前值，第二轮起 `count > last_count` 恒为 false，
唯一判据只剩 `text != before.1`。连续两次问同一问题、网页返回相同短答（如都回"收到"）时
`saw_new` 永不置位 → 走满 180s 超时。

修复：判据改为相对**发送前快照** `count != before.0 || text != before.1`。
`!=` 而非 `>`，是为了同时覆盖新会话条数重置（3→1）的情形；稳定期内该条件不再翻转，不会误判。

### 2. 取消会泄漏 tokio 任务、条目永久卡在 streaming
原 `cancel_current` 只置标志；轮询任务下轮直接 `return`，既不投递事件也不释放订阅者。
消费任务仍在 `rx.recv().await` 上等待，而 tx 存活于 `subscriber` 中 → channel 永不关闭 →
任务永久挂起，对应 exchange 停在 streaming 状态且不落库。

修复：新增私有 `finish(event)`，`subscriber.lock().take()` 一次完成"投递 + 摘除"，
取消/断连/超时/Done 四条路径统一走它。`cancel_message` 不再自行 emit，
避免"命令层 + 轮询层"双源广播同一事件。

### 3. 调试残留污染生产路径
`eprintln!` 四处在 `src/` 内；其中一行还额外 `evaluate("location.href")` 并把结果只用于打印
——每个 tick（250ms）多一次无意义 CDP 往返。全部删除。

### 4. 附带的设计收敛
- 发送前快照由 `send_message` 作为返回值 `(usize, String)` 交给调用方，
  不再存进 `CdpClient.before` 字段。一次性传参不该占用对象状态，也消除了跨调用时序耦合。
- 新增 `--danger` / `--danger-soft` 设计令牌（明暗双值）。原 `#d70015` 在两处 CSS 硬编码，
  暗色主题（`#1c1c1e` 背景）下对比度不足，实际不可读。

### 5. 已核实不成立的疑点
- 删除 `install_binding()`（含 `Runtime.enable` / `DOM.enable` / `addBinding`）**不影响图片上传**：
  `upload_files` 走 `Runtime.evaluate` 取 objectId 再 `DOM.setFileInputFiles`，按 objectId 寻址，
  不依赖 DOM 域节点树。
- `browser_status` 为实时探测（`ensure_cdp` + `current_url` + `input_ready`），
  设置页「检测登录状态」拿到的是当前状态，非缓存。

