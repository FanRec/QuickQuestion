# M2 详细设计 — CDP 内核：浏览器启动与连接

## 目标
在 Rust 侧建立可靠的 CDP 基础设施：能启动/复用 Edge、连上 DeepSeek 页面、执行 JS、探测输入框、读取页面 URL。**此里程碑不发送真实消息、不读数据库**，用集成测试验证内核可用。

## 模块边界（遵循 ARCHITECTURE.md §4 依赖方向）

```
commands/  →  browser/  →  model/
              cdp/      →  model/
```
- `cdp/` 不依赖 `store/`，只做网页交互。
- `browser/` 不依赖 `cdp/`，只管进程与端口。
- 二者由 M3 的 `commands/` 编排。

## model 层（src-tauri/src/model.rs）
```rust
pub struct BrowserStatus {
    pub ready: bool,
    pub port: u16,
    pub page_url: String,
    pub input_ready: bool,
}
```

## browser 模块（src-tauri/src/browser/mod.rs）

职责：启动/复用 Edge，暴露调试端口，维护专用 profile。

关键实现点（源码级证据来自参考项目 BrowserManager.cs）：
- 启动参数：`--remote-debugging-port=9222`、`--remote-allow-origins=*`、`--user-data-dir=<profile>`、`--app=https://chat.deepseek.com`、`--no-first-run`、`--disable-blink-features=AutomationControlled`、`--window-position=-10000,-10000`（离屏启动避免闪窗）。
- profile 路径：`%LOCALAPPDATA%/QuickQuestion/browser-profile`（专用，复用登录态）。
- 复用逻辑：先探测 `http://127.0.0.1:9222/json/version`，若端口已就绪则直接复用，不重复启动。
- 进程句柄保存在 `Mutex<Option<Child>>`，应用退出时 kill。
- 找不到 Edge/Chrome 时返回明确错误（中文提示）。

## cdp 模块（src-tauri/src/cdp/mod.rs）

职责：CDP WebSocket 客户端。

关键实现点（源码级证据来自参考项目 CdpClient.cs）：
- `GET http://127.0.0.1:{port}/json` → 找 `type=="page"` 且 `url` 含 `chat.deepseek.com` 的 `webSocketDebuggerUrl`；没有则 `PUT /json/new?https://chat.deepseek.com` 新建页面。
- WebSocket 连接（`tokio-tungstenite`），`KeepAlive` 15s。
- 请求/响应关联：`AtomicI32 id` 自增， `HashMap<i32, oneshot::Sender<JsonValue>>` 挂起，接收循环按 id 分发。
- `CallAsync(method, params)` → 发 JSON、等待对应 id 响应、超时 15s。
- `EvaluateAsync(js)` → `Runtime.evaluate` + `returnByValue:true` + `awaitPromise:true`，取 `result.result.value`。
- 输入框探测 JS（多候选 + 可见性判定）：依次 `textarea`、`[contenteditable="true"]`、`[role="textbox"]`，只取可见元素；返回是否存在。
- 导航：`Page.navigate` + 等待 `document.readyState=="complete"`。
- 连接后校验 URL 含 `chat.deepseek.com`，否则导航过去。

## commands 层（本 M2 只暴露只读命令）
- `browser_status() -> BrowserStatus`：确保浏览器就绪后返回状态（含 input_ready）。
- 供前端/测试验证内核。

## 依赖清单（新增）
```toml
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = "0.28"
futures-util = "0.3"
reqwest = { version = "0.12", features = ["json"] }
uuid = { version = "1", features = ["v4"] }
```

## 验收清单
1. `cargo check` 通过。
2. 集成测试（Rust `#[test]`，忽略式 `#[ignore]`，需手动跑）：启动浏览器 → 连接 CDP → `EvaluateAsync("location.href")` 返回 DeepSeek URL → 输入框探测返回布尔。
3. Tauri 命令 `browser_status` 可从前端 invoke 返回结构。
4. 代码审查：请求/响应关联无竞态、超时覆盖、错误有中文提示、无 panic 路径。
5. git commit。

## 已知遗留（明确登记，非隐藏）
- **浏览器进程回收**：`AppState::browser` 持有子进程句柄，但 `run()` 尚未在退出时调用 `shutdown()`。
  测试证实测试进程结束后调试浏览器会自行退出，但正常应用退出路径未验证。
  登记到 M6「端到端联调」处理（on_exit 钩子 + Drop 守护）。
- **登录态**：新 profile 首次运行停在 `chat.deepseek.com/sign_in`，需用户手动登录一次；
  这是设计预期（复用登录态），非缺陷。集成测试因此只断言 URL 含 `chat.deepseek.com`，
  不断言 input_ready=true。

## 审查关注点
- 接收循环与挂起表的一致性（断开时唤醒所有挂起请求，避免悬挂）。
- 浏览器进程生命周期（重复 start 不产生多进程）。
- 超时与取消传播。
- JS 注入字符串用 `serde_json::to_string` 转义，不手工拼接用户输入（为 M3 安全打基础）。
