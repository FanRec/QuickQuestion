use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::error::AppError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 从 `https://chat.deepseek.com/a/chat/s/{uuid}...` 中取出 uuid。
fn parse_chat_id(url: &str) -> String {
    let Some(rest) = url.split("/a/chat/s/").nth(1) else {
        return String::new();
    };
    rest.split(['?', '#', '/'])
        .next()
        .unwrap_or("")
        .to_string()
}

/// 页面流式事件：由注入脚本经 CDP binding 推送，再经 mpsc 转给命令层。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Done { text: String },
    Error { message: String },
}

/// 输入框探测 JS：多候选 + 可见性判定，页面结构变化时仍有机会命中。
const FIND_INPUT_JS: &str = r#"
(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  var groups = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  for (var g = 0; g < groups.length; g++) {
    var list = document.querySelectorAll(groups[g]);
    for (var i = 0; i < list.length; i++) {
      if (!list[i].disabled && visible(list[i])) return true;
    }
  }
  return false;
})()
"#;

/// 读取最后一条助手回复，并尽量还原成 Markdown。
/// 关键在于公式：网页里已经是 KaTeX 渲染后的 DOM，innerText 会把分子分母、上下标
/// 拆成独立行；必须从 annotation 里取回原始 LaTeX，才能在前端正确重渲。
const LAST_REPLY_JS: &str = r#"
(function () {
  var sel = '.ds-assistant-message-main-content, [class*="ds-assistant-message-main-content"]';
  var list = document.querySelectorAll(sel);
  if (!list.length) return JSON.stringify({ count: 0, text: '' });
  var box = list[list.length - 1].cloneNode(true);

  function texOf(el) {
    var a = el.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent : '';
  }
  box.querySelectorAll('.katex-display').forEach(function (el) {
    var t = texOf(el);
    el.replaceWith(document.createTextNode(t ? '\n\n$$' + t + '$$\n\n' : ''));
  });
  box.querySelectorAll('.katex').forEach(function (el) {
    var t = texOf(el);
    el.replaceWith(document.createTextNode(t ? '$' + t + '$' : ''));
  });
  // 没取到 LaTeX 的渲染层直接丢弃，避免同样的字符出现两遍。
  box.querySelectorAll('.katex-html, .katex-mathml').forEach(function (el) { el.remove(); });

  box.querySelectorAll('pre').forEach(function (pre) {
    var code = pre.querySelector('code');
    var lang = '';
    if (code) {
      var m = (code.className || '').match(/language-([\w+-]+)/);
      if (m) lang = m[1];
    }
    var body = (pre.innerText || '').replace(/\n+$/, '');
    pre.replaceWith(document.createTextNode('\n```' + lang + '\n' + body + '\n```\n'));
  });

  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(function (tag, i) {
    box.querySelectorAll(tag).forEach(function (el) {
      var hashes = new Array(i + 2).join('#');
      el.replaceWith(document.createTextNode('\n' + hashes + ' ' + (el.innerText || '').trim() + '\n'));
    });
  });

  box.querySelectorAll('li').forEach(function (li) {
    li.replaceWith(document.createTextNode('\n- ' + (li.innerText || '').trim()));
  });

  box.querySelectorAll('strong, b').forEach(function (el) {
    el.replaceWith(document.createTextNode('**' + (el.innerText || '') + '**'));
  });
  box.querySelectorAll('code').forEach(function (el) {
    if (el.closest('pre')) return;
    el.replaceWith(document.createTextNode('`' + (el.innerText || '') + '`'));
  });

  var text = (box.innerText || box.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  return JSON.stringify({ count: list.length, text: text });
})()
"#;

/// 写入输入框兼容 textarea 与 contenteditable；msg 由调用方用 serde_json 转义后拼入。
fn write_input_js(msg_json: &str) -> String {
    format!(
        r#"
(function () {{
  function visible(el) {{
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }}
  var groups = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  var el = null;
  for (var g = 0; g < groups.length && !el; g++) {{
    var list = document.querySelectorAll(groups[g]);
    for (var i = 0; i < list.length; i++) {{
      if (!list[i].disabled && visible(list[i])) {{ el = list[i]; break; }}
    }}
  }}
  if (!el) return 'NO_INPUT';
  var msg = {msg_json};
  el.focus();
  if (typeof el.value === 'string' && !el.isContentEditable) {{
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, msg); else el.value = msg;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }} else {{
    try {{
      var sel = window.getSelection(); var range = document.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, msg);
    }} catch (e) {{}}
    if (!(el.innerText || '').trim()) el.textContent = msg;
  }}
  return 'OK';
}})()
"#,
        msg_json = msg_json
    )
}

/// CDP WebSocket 客户端。请求通过自增 id 与 oneshot 关联，接收循环按 id 分发。
pub struct CdpClient {
    port: u16,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    /// 当前流式订阅者；每次 send_message 前由 subscribe 安装，支持多次问答。
    subscriber: Arc<Mutex<Option<mpsc::UnboundedSender<StreamEvent>>>>,
    /// 连接存活标志；接收循环退出时置 false，供 ensure_cdp 判断重连。
    alive: Arc<AtomicBool>,
    /// 取消标志；cancel_current 置 true，轮询任务据此停止。
    cancelled: Arc<AtomicBool>,
    sender: Mutex<futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >>,
}

impl CdpClient {
    /// 连接端口上的 DeepSeek 页面；没有则通过 CDP 新建页面。
    pub async fn connect(port: u16) -> Result<Self, AppError> {
        let ws_url = find_page_socket(port).await?;
        let (stream, _) = connect_async(&ws_url)
            .await
            .map_err(|e| AppError::msg(format!("连接 CDP 失败：{e}")))?;
        let (sender, mut receiver) = stream.split();

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let subscriber: Arc<Mutex<Option<mpsc::UnboundedSender<StreamEvent>>>> =
            Arc::new(Mutex::new(None));

        // 接收循环：按 id 唤醒挂起请求；bindingCalled 事件转给当前订阅者；
        // 连接关闭时清空挂起表，避免永久悬挂。
        let pending_clone = pending.clone();
        let subscriber_clone = subscriber.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = alive.clone();
        tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            if let Some(id) = value.get("id").and_then(Value::as_i64) {
                                let mut map = pending_clone.lock().await;
                                if let Some(tx) = map.remove(&id) {
                                    let _ = tx.send(value);
                                }
                                continue;
                            }
                            // 页面经 Runtime.addBinding 推送的流式事件。
                            if value.get("method").and_then(Value::as_str)
                                == Some("Runtime.bindingCalled")
                            {
                                if let Some(payload) = value
                                    .get("params")
                                    .and_then(|p| p.get("payload"))
                                    .and_then(Value::as_str)
                                {
                                    if let Ok(event) = serde_json::from_str::<StreamEvent>(payload) {
                                        let sub = subscriber_clone.lock().await;
                                        if let Some(tx) = sub.as_ref() {
                                            let _ = tx.send(event);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            pending_clone.lock().await.clear();
            alive_clone.store(false, Ordering::SeqCst);
        });

        let client = Self {
            port,
            next_id: AtomicI64::new(0),
            pending,
            subscriber,
            alive,
            cancelled: Arc::new(AtomicBool::new(false)),
            sender: Mutex::new(sender),
        };

        // 校验/导航到 DeepSeek。
        let href = client.evaluate("location.href").await.unwrap_or_default();
        if !href.contains("chat.deepseek.com") {
            client
                .call("Page.navigate", json!({ "url": "https://chat.deepseek.com" }))
                .await?;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        // 等待页面布局完成、输入框可见，避免连接后立刻发消息命中未加载的页面。
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            if client.input_ready().await.unwrap_or(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(client)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = json!({ "id": id, "method": method, "params": params });
        {
            let mut sender = self.sender.lock().await;
            sender
                .send(Message::Text(payload.to_string().into()))
                .await
                .map_err(|e| AppError::msg(format!("发送 CDP 命令失败：{e}")))?;
        }

        let result = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| AppError::msg(format!("CDP 命令超时：{method}")))
            .and_then(|r| r.map_err(|_| AppError::msg("CDP 响应通道已关闭".to_string())))?;

        if let Some(error) = result.get("error") {
            return Err(AppError::msg(format!("CDP 错误：{error}")));
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 执行 JS 并返回字符串值。
    pub async fn evaluate(&self, expression: &str) -> Result<String, AppError> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(AppError::msg(format!("页面脚本异常：{exception}")));
        }
        let value = result.get("result").and_then(|r| r.get("value"));
        Ok(match value {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        })
    }

    pub async fn current_url(&self) -> Result<String, AppError> {
        self.evaluate("location.href").await
    }

    pub async fn input_ready(&self) -> Result<bool, AppError> {
        let raw = self.evaluate(FIND_INPUT_JS).await?;
        Ok(raw.trim() == "true")
    }

    /// 为本轮问答安装新的订阅者，返回接收端。旧订阅者被替换（上一轮应已结束）。
    pub async fn subscribe(&self) -> mpsc::UnboundedReceiver<StreamEvent> {
        let (tx, rx) = mpsc::unbounded_channel::<StreamEvent>();
        *self.subscriber.lock().await = Some(tx);
        rx
    }

    /// 清除当前订阅者，防止页面残留事件泄漏到下一轮。
    pub async fn unsubscribe(&self) {
        *self.subscriber.lock().await = None;
    }

    /// 连接是否存活。
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// 取消当前接收：清订阅者并断开页面 observer。
    /// 注意：网页端的生成无法被强制停止，这里只停止本机接收。
    pub fn cancel_current(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// 开始新一轮前重置取消标志。
    pub fn reset_cancel(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// 导航到指定地址并等待输入框就绪。切会话和开新会话共用。
    async fn navigate_and_wait(&self, url: &str, what: &str) -> Result<(), AppError> {
        self.call("Page.navigate", json!({ "url": url })).await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            if self.input_ready().await.unwrap_or(false) {
                // 输入框出现后再稳一拍，避免紧接着发送命中正在重排的页面。
                tokio::time::sleep(Duration::from_millis(400)).await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err(AppError::msg(format!("{what}超时，请重试。")))
    }

    /// 在网页端开启全新对话：直接导航首页。
    /// 曾尝试点「开启新对话」按钮，但它是无 role 的 hash-class DIV，点击不生效；
    /// 导航首页是唯一可靠的做法。
    pub async fn new_conversation(&self) -> Result<(), AppError> {
        self.navigate_and_wait("https://chat.deepseek.com/", "开启新会话")
            .await
    }

    /// 切到指定的 DeepSeek 会话（SPA 内导航，保留该会话的上下文）。
    pub async fn navigate_to_chat(&self, chat_id: &str) -> Result<(), AppError> {
        if chat_id.is_empty() {
            return Err(AppError::msg("该会话尚未绑定网页会话，无法接续。".to_string()));
        }
        let url = format!("https://chat.deepseek.com/a/chat/s/{chat_id}");
        self.navigate_and_wait(&url, "切换会话").await
    }

    /// 从当前页面 URL 读出 DeepSeek 会话 UUID；首页/登录页返回空串。
    pub async fn current_chat_id(&self) -> Result<String, AppError> {
        let url = self.current_url().await?;
        Ok(parse_chat_id(&url))
    }

    /// 把浏览器窗口移到屏幕中央并显示，供用户完成登录。
    /// 平时窗口被放在屏幕外，登录场景必须让它可见。
    pub async fn show_browser_window(&self) -> Result<(), AppError> {
        let url = format!("http://127.0.0.1:{}/json/list", self.port);
        let list: Vec<Value> = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败：{e}")))?
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::msg(format!("读取浏览器页面失败：{e}")))?
            .json()
            .await
            .map_err(|e| AppError::msg(format!("解析页面列表失败：{e}")))?;

        let page = list
            .iter()
            .find(|p| {
                p.get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|u| u.contains("deepseek"))
            })
            .ok_or_else(|| AppError::msg("未找到 DeepSeek 页面，请稍后重试。".to_string()))?;
        let target_id = page
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::msg("未取到页面标识。".to_string()))?
            .to_string();

        let window = self
            .call("Browser.getWindowForTarget", json!({ "targetId": target_id }))
            .await?;
        let window_id = window
            .get("windowId")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::msg("未取到浏览器窗口标识。".to_string()))?;

        // 用页面自己报告的分辨率居中，不额外依赖系统屏幕 API。
        let screen = self
            .evaluate("JSON.stringify({ w: screen.availWidth, h: screen.availHeight })")
            .await
            .unwrap_or_default();
        let metrics: Value = serde_json::from_str(&screen).unwrap_or(Value::Null);
        let sw = metrics.get("w").and_then(Value::as_f64).unwrap_or(1280.0);
        let sh = metrics.get("h").and_then(Value::as_f64).unwrap_or(800.0);
        let w = (sw * 0.62).round().max(900.0);
        let h = (sh * 0.72).round().max(620.0);

        self.call(
            "Browser.setWindowBounds",
            json!({
                "windowId": window_id,
                "bounds": {
                    "left": ((sw - w) / 2.0).round() as i64,
                    "top": ((sh - h) / 2.0).round() as i64,
                    "width": w as i64,
                    "height": h as i64,
                    "windowState": "normal"
                }
            }),
        )
        .await?;
        Ok(())
    }

    /// 发送前检测验证码/人机验证页面。
    pub async fn captcha_present(&self) -> bool {
        let js = r#"(function(){
          var t = document.body.innerText || '';
          if (/人机验证|滑动验证|安全验证|请完成验证/.test(t)) return true;
          if (document.querySelector('iframe[src*="captcha"], [class*="captcha"]')) return true;
          return false;
        })()"#;
        self.evaluate(js).await.unwrap_or_default().trim() == "true"
    }

    /// 把「深度思考」「智能搜索」两个开关同步到目标状态。
    /// 定位依据是页面稳定的 aria-pressed 语义属性 + 文案，不依赖会变的 hash class。
    /// 已是目标状态则不动，切换后轮询确认，避免静默失败。
    pub async fn apply_modes(&self, deep_think: bool, web_search: bool) -> Result<(), AppError> {
        let js = format!(
            r#"(async function(){{
  function find(label){{
    var list = document.querySelectorAll('[aria-pressed]');
    for (var i = 0; i < list.length; i++) {{
      if ((list[i].textContent || '').trim() === label) return list[i];
    }}
    return null;
  }}
  async function setMode(label, want){{
    for (var attempt = 0; attempt < 2; attempt++) {{
      var el = find(label);
      if (!el) return 'MISSING';
      if ((el.getAttribute('aria-pressed') === 'true') === want) return 'OK';
      el.click();
      for (var i = 0; i < 8; i++) {{
        await new Promise(function(r){{ setTimeout(r, 120); }});
        var now = find(label);
        if (now && (now.getAttribute('aria-pressed') === 'true') === want) return 'OK';
      }}
    }}
    return 'FAIL';
  }}
  var a = await setMode('深度思考', {deep});
  var b = await setMode('智能搜索', {web});
  return a + '|' + b;
}})()"#,
            deep = deep_think,
            web = web_search,
        );
        let out = self.evaluate(&js).await?;
        let (a, b) = out.split_once('|').unwrap_or((out.as_str(), ""));
        for (label, state) in [("深度思考", a), ("智能搜索", b)] {
            if state == "OK" {
                continue;
            }
            let reason = match state {
                "MISSING" => "页面上找不到该开关，页面结构可能已变化",
                "FAIL" => "切换后状态未生效",
                _ => "未知错误",
            };
            return Err(AppError::msg(format!("设置「{label}」失败：{reason}")));
        }
        Ok(())
    }

    /// 通过 CDP 设置文件输入（图片上传）。
    pub async fn upload_files(&self, files: &[String]) -> Result<(), AppError> {
        if files.is_empty() {
            return Ok(());
        }
        let object = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "document.querySelector('input[type=file]')",
                    "returnByValue": false
                }),
            )
            .await?;
        let object_id = object
            .get("result")
            .and_then(|r| r.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::msg("未找到 DeepSeek 文件上传控件。"))?;
        self.call(
            "DOM.setFileInputFiles",
            json!({ "files": files, "objectId": object_id }),
        )
        .await?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        Ok(())
    }

    /// 读取当前最后一条回复的 Markdown 文本（每次全新查询，不受页面导航影响）。
    pub async fn read_reply(&self) -> Result<(usize, String), AppError> {
        let raw = self.evaluate(LAST_REPLY_JS).await?;
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let count = value.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
        let text = value.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        Ok((count, text))
    }

    /// 写入文字并发送，返回发送前的回复快照 (条数, 文本)。
    /// 快照交给 spawn_reply_poller 判断"哪条是新回复"，避免误认上一轮内容。
    pub async fn send_message(
        self: &Arc<Self>,
        text: &str,
        files: &[String],
    ) -> Result<(usize, String), AppError> {
        let url = self.current_url().await.unwrap_or_default();
        if url.contains("sign_in") || url.contains("login") {
            return Err(AppError::msg("DeepSeek 尚未登录，请先在浏览器中完成登录。"));
        }
        if !self.input_ready().await? {
            return Err(AppError::msg("未找到 DeepSeek 输入框，页面结构可能已变化。"));
        }
        if self.captcha_present().await {
            return Err(AppError::msg("检测到人机验证，请在浏览器中手动完成后重试。"));
        }

        self.upload_files(files).await?;

        let msg_json = serde_json::to_string(text)
            .map_err(|e| AppError::msg(format!("消息编码失败：{e}")))?;
        let result = self.evaluate(&write_input_js(&msg_json)).await?;
        if result.trim() != "OK" {
            return Err(AppError::msg("无法写入 DeepSeek 输入框。"));
        }

        // 发送前快照：新回复必须与之不同（条数变化或文本变化）才算数。
        let before = self.read_reply().await.unwrap_or((0, String::new()));

        self.evaluate(
            r#"(function(){
              var el = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
              if (!el) return 'NO_INPUT';
              el.focus();
              ['keydown','keypress','keyup'].forEach(function(type){
                el.dispatchEvent(new KeyboardEvent(type, {
                  key:'Enter', code:'Enter', keyCode:13, which:13,
                  bubbles:true, cancelable:true, isComposing:false }));
              });
              return 'OK';
            })()"#,
        )
        .await?;
        Ok(before)
    }

    /// 结束本轮：取出并清空订阅者，投递最终事件。
    /// 一次 take 完成"发送 + 摘除"，消费端随后 unsubscribe 不会残留悬挂。
    async fn finish(&self, event: StreamEvent) {
        if let Some(tx) = self.subscriber.lock().await.take() {
            let _ = tx.send(event);
        }
    }

    /// Rust 侧轮询回复并推送事件：每次全新 JS 查询，页面导航不影响。
    /// before 为发送前快照，用于识别"本轮新回复"，避免把上一轮内容当结果。
    pub fn spawn_reply_poller(self: Arc<Self>, before: (usize, String), quiet_ms: u64) {
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(180);
            let mut last = before.1.clone();
            let mut saw_new = false;
            let mut stable_ms: u64 = 0;
            let tick = Duration::from_millis(250);
            // 发送触发 SPA 导航到会话页，先给页面一点时间稳定再读取。
            tokio::time::sleep(Duration::from_millis(600)).await;

            while std::time::Instant::now() < deadline {
                if !self.alive.load(Ordering::SeqCst) {
                    self.finish(StreamEvent::Error {
                        message: "浏览器连接已断开，请重试。".to_string(),
                    })
                    .await;
                    return;
                }
                if self.cancelled.load(Ordering::SeqCst) {
                    self.finish(StreamEvent::Error {
                        message: "已取消".to_string(),
                    })
                    .await;
                    return;
                }
                tokio::time::sleep(tick).await;
                let (count, text) = match self.read_reply().await {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if text.is_empty() {
                    continue;
                }
                // 条数相对快照变化（新增或新会话重置），或文本被改写，都算本轮新回复。
                if count != before.0 || text != before.1 {
                    saw_new = true;
                }
                if saw_new && text != last {
                    // 增量到达：推送完整文本，前端做替换（简单可靠）。
                    if let Some(tx) = self.subscriber.lock().await.as_ref() {
                        let _ = tx.send(StreamEvent::Delta { text: text.clone() });
                    }
                    stable_ms = 0;
                } else if saw_new {
                    stable_ms += tick.as_millis() as u64;
                }
                last = text.clone();

                if saw_new && stable_ms >= quiet_ms {
                    self.finish(StreamEvent::Done { text }).await;
                    return;
                }
            }
            self.finish(StreamEvent::Error {
                message: "等待 DeepSeek 回复超时。".to_string(),
            })
            .await;
        });
    }
}

/// 从 CDP HTTP 端点找到 DeepSeek 页面的 WebSocket 调试地址。
async fn find_page_socket(port: u16) -> Result<String, AppError> {
    let url = format!("http://127.0.0.1:{port}/json");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败：{e}")))?;

    let mut created = false;
    for attempt in 0..30 {
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(list) = resp.json::<Vec<Value>>().await {
                // 多个 DeepSeek 标签会导致消息发到 A 页、回复出现在 B 页。
                // 保留最后一个（最新标签），关闭其余，确保单一确定页面。
                let deepseek_pages: Vec<&Value> = list
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("page"))
                    .filter(|item| {
                        item.get("url")
                            .and_then(Value::as_str)
                            .is_some_and(|u| u.contains("chat.deepseek.com"))
                    })
                    .collect();
                if let Some((keep, extras)) = deepseek_pages.split_last() {
                    for extra in extras {
                        if let Some(id) = extra.get("id").and_then(Value::as_str) {
                            let _ = client
                                .get(format!("http://127.0.0.1:{port}/json/close/{id}"))
                                .send()
                                .await;
                        }
                    }
                    if let Some(ws) = keep.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                        return Ok(ws.to_string());
                    }
                }
            }
        }
        // 首轮未找到则新建一次页面，后续继续轮询等待其出现。
        if attempt == 0 && !created {
            created = true;
            let new_url = format!("http://127.0.0.1:{port}/json/new?https://chat.deepseek.com");
            let _ = client.put(&new_url).send().await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(AppError::msg(
        "未找到 DeepSeek 页面，请确认浏览器已启动并登录 chat.deepseek.com。",
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_chat_id;

    #[test]
    fn parses_chat_id_from_session_url() {
        let url = "https://chat.deepseek.com/a/chat/s/b49ad49d-3f41-446f-8c5c-b827013c4b92";
        assert_eq!(parse_chat_id(url), "b49ad49d-3f41-446f-8c5c-b827013c4b92");
    }

    #[test]
    fn strips_query_and_fragment() {
        let url = "https://chat.deepseek.com/a/chat/s/abc-123?foo=1#bar";
        assert_eq!(parse_chat_id(url), "abc-123");
    }

    #[test]
    fn empty_on_homepage() {
        assert_eq!(parse_chat_id("https://chat.deepseek.com/"), "");
    }
}
