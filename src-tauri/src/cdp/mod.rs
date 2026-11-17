use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::error::AppError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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

/// 安装 mutation observer + 完成状态机；quiet_ms 为完成判定的静默窗口。
fn install_observer_js(quiet_ms: u64) -> String {
    r#"
(function () {
  var SEL = '.ds-assistant-message-main-content, [class*="ds-assistant-message-main-content"]';
  function emit(o) { try { window.__qq_emit(JSON.stringify(o)); } catch (e) {} }

  if (window.__qqObserver) { window.__qqObserver.disconnect(); }
  if (window.__qqQuietTimer) { clearTimeout(window.__qqQuietTimer); }

  var baseline = document.querySelectorAll(SEL).length;
  var lastText = '';
  var started = false;
  var finished = false;

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim();
  }
  function lastAssistant() {
    var list = document.querySelectorAll(SEL);
    return list.length > baseline ? list[list.length - 1] : null;
  }
  function check() {
    if (finished) return;
    var el = lastAssistant();
    if (!el) return;
    var text = textOf(el);
    if (!text) return;
    if (!started) { started = true; }
    if (text !== lastText) {
      lastText = text;
      emit({ type: 'delta', text: text });
      if (window.__qqQuietTimer) clearTimeout(window.__qqQuietTimer);
      window.__qqQuietTimer = setTimeout(function () {
        if (!finished) {
          finished = true;
          emit({ type: 'done', text: lastText });
          if (window.__qqObserver) window.__qqObserver.disconnect();
        }
      }, __QUIET_MS__);
    }
  }
  window.__qqObserver = new MutationObserver(check);
  window.__qqObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  return 'OK';
})()
"#.replace("__QUIET_MS__", &quiet_ms.to_string())
}

/// CDP WebSocket 客户端。请求通过自增 id 与 oneshot 关联，接收循环按 id 分发。
pub struct CdpClient {
    port: u16,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    /// 当前流式订阅者；每次 send_message 安装新的，支持多次问答。
    subscriber: Arc<Mutex<Option<mpsc::UnboundedSender<StreamEvent>>>>,
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
        });

        let client = Self {
            port,
            next_id: AtomicI64::new(0),
            pending,
            subscriber,
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

    /// 注册页面→Rust 的 binding 通道并启用 Runtime 域。
    pub async fn install_binding(&self) -> Result<(), AppError> {
        self.call("Runtime.enable", json!({})).await?;
        self.call("DOM.enable", json!({})).await?;
        self.call(
            "Runtime.addBinding",
            json!({ "name": "__qq_emit" }),
        )
        .await?;
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

    /// 写入文字、安装监听器并发送。调用方负责从 take_stream_rx 消费事件。
    pub async fn send_message(&self, text: &str, files: &[String], quiet_ms: u64) -> Result<(), AppError> {
        // 安全检查：未登录则明确报错，不静默等待。
        let url = self.current_url().await.unwrap_or_default();
        if url.contains("sign_in") || url.contains("login") {
            return Err(AppError::msg(
                "DeepSeek 尚未登录，请先在浏览器中完成登录。".to_string(),
            ));
        }
        if !self.input_ready().await? {
            return Err(AppError::msg(
                "未找到 DeepSeek 输入框，页面结构可能已变化。".to_string(),
            ));
        }

        self.install_binding().await?;
        self.upload_files(files).await?;

        // 用 serde_json 转义后拼入 JS，避免注入。
        let msg_json = serde_json::to_string(text)
            .map_err(|e| AppError::msg(format!("消息编码失败：{e}")))?;
        let result = self.evaluate(&write_input_js(&msg_json)).await?;
        if result.trim() != "OK" {
            return Err(AppError::msg("无法写入 DeepSeek 输入框。".to_string()));
        }

        self.evaluate(&install_observer_js(quiet_ms)).await?;

        // 派发 Enter 发送。
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
        Ok(())
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
                for item in &list {
                    if item.get("type").and_then(Value::as_str) != Some("page") {
                        continue;
                    }
                    let page_url = item.get("url").and_then(Value::as_str).unwrap_or("");
                    if page_url.contains("chat.deepseek.com") {
                        if let Some(ws) = item.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                            return Ok(ws.to_string());
                        }
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
