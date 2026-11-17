use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::error::AppError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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

/// CDP WebSocket 客户端。请求通过自增 id 与 oneshot 关联，接收循环按 id 分发。
pub struct CdpClient {
    port: u16,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
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

        // 接收循环：按 id 唤醒挂起请求；连接关闭时清空挂起表，避免永久悬挂。
        let pending_clone = pending.clone();
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
