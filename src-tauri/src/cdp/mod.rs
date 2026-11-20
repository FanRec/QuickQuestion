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
    Error { message: String, kind: Option<String> },
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

/// 登录态探测：URL + 可见登录 UI + 输入框缺失三类信号，返回结构化原因。
const LOGIN_STATE_JS: &str = r#"
(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  var url = location.href;
  var reason = '';
  if (/sign_in|login/.test(url)) reason = 'url';

  if (!reason) {
    var nodes = document.querySelectorAll('button,[role="button"],a');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var t = ((el.innerText || el.textContent || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim();
      if (/^(登录|立即登录|扫码登录|手机号登录|验证码登录|Sign in|Log in)$/i.test(t)) {
        reason = 'ui';
        break;
      }
    }
  }

  var input = null;
  var groups = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  for (var g = 0; g < groups.length && !input; g++) {
    var list = document.querySelectorAll(groups[g]);
    for (var k = 0; k < list.length; k++) {
      if (!list[k].disabled && visible(list[k])) { input = list[k]; break; }
    }
  }
  var inputReady = !!input;
  if (!reason && !inputReady && /登录|log\s*in/i.test(document.body.innerText || '')) reason = 'emptyInput';

  return JSON.stringify({
    needsLogin: !!reason,
    reason: reason,
    pageUrl: url,
    inputReady: inputReady
  });
})()
"#;

fn mark_reply_js(msg_json: &str) -> String {
    format!(
        r#"
(function () {{
  window.__qqSentText = {msg_json};
  var list = document.querySelectorAll('.ds-message');
  for (var i = 0; i < list.length; i++) list[i].setAttribute('data-qq-prev', '1');
  return String(list.length);
}})()
"#,
        msg_json = msg_json
    )
}

/// 读取本轮新回复，并附带网页自身的"是否仍在生成"状态。
/// 公式仍从 annotation 取回原始 LaTeX；网页 UI 噪声（引用角标、代码块头）在克隆节点上删掉。
const READ_REPLY_JS: &str = r#"
(function () {
  function generatingNow() {
    var btn = document.querySelector('[role="button"].ds-button--circle.ds-button--primary');
    if (btn && !btn.classList.contains('ds-button--disabled')) return true;
    var leaves = document.querySelectorAll('span,div');
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      if (el.children.length) continue;
      var t = (el.textContent || '').trim();
      if (/^(正在思考|搜索中|正在搜索|正在生成|正在查找|正在浏览网页|Thinking|Searching)/.test(t)) return true;
    }
    return false;
  }

  // 身份锚点：刚发出的用户消息没打标，且文本与 window.__qqSentText 一致；
  // 它的下一个 .ds-message 才是本轮助手回复。只靠"最后一个未打标"不够，
  // 联网阶段旧消息懒加载时也会变成未打标。
  var box = null;
  var list = document.querySelectorAll('.ds-message');
  for (var i = 0; i < list.length; i++) {
    if (list[i].hasAttribute('data-qq-prev')) continue;
    var t = (list[i].innerText || '').trim();
    if (window.__qqSentText && t.indexOf(window.__qqSentText) >= 0) {
      var n = list[i].nextElementSibling;
      while (n && !n.querySelector('.ds-assistant-message-main-content')) n = n.nextElementSibling;
      if (n) box = n;
      break;
    }
  }
  // 图片提问等文本为空的场景：退回最后一个未打标的助手消息。
  if (!box) {
    for (var k = list.length - 1; k >= 0; k--) {
      if (!list[k].hasAttribute('data-qq-prev') && list[k].querySelector('.ds-assistant-message-main-content')) {
        box = list[k];
        break;
      }
    }
  }
  if (!box) return JSON.stringify({ found: false, text: '', generating: generatingNow() });

  // 网页在回复末尾显示的免责声明是比静默更可靠的完成标记（避开 hash class）。
  var doneMark = false;
  var divs = box.querySelectorAll('div');
  for (var j = 0; j < divs.length; j++) {
    if ((divs[j].textContent || '').indexOf('本回答由 AI 生成') >= 0) { doneMark = true; break; }
  }
  var generating = generatingNow() && !doneMark;

  var content = box.querySelector('.ds-assistant-message-main-content').cloneNode(true);
  content.querySelectorAll('[data-citation-group], .ds-markdown-cite').forEach(function (el) { el.remove(); });
  content.querySelectorAll('.md-code-block-banner-wrap').forEach(function (el) { el.remove(); });

  function texOf(el) {
    var a = el.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent : '';
  }
  content.querySelectorAll('.katex-display').forEach(function (el) {
    var t = texOf(el);
    el.replaceWith(document.createTextNode(t ? '\n\n$$' + t + '$$\n\n' : ''));
  });
  content.querySelectorAll('.katex').forEach(function (el) {
    var t = texOf(el);
    el.replaceWith(document.createTextNode(t ? '$' + t + '$' : ''));
  });
  content.querySelectorAll('.katex-html, .katex-mathml').forEach(function (el) { el.remove(); });

  content.querySelectorAll('pre').forEach(function (pre) {
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
    content.querySelectorAll(tag).forEach(function (el) {
      var hashes = new Array(i + 2).join('#');
      el.replaceWith(document.createTextNode('\n' + hashes + ' ' + (el.innerText || '').trim() + '\n'));
    });
  });
  content.querySelectorAll('li').forEach(function (li) {
    li.replaceWith(document.createTextNode('\n- ' + (li.innerText || '').trim()));
  });
  content.querySelectorAll('strong, b').forEach(function (el) {
    el.replaceWith(document.createTextNode('**' + (el.innerText || '') + '**'));
  });
  content.querySelectorAll('code').forEach(function (el) {
    if (el.closest('pre')) return;
    el.replaceWith(document.createTextNode('`' + (el.innerText || '') + '`'));
  });

  var text = (content.innerText || content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  return JSON.stringify({ found: true, text: text, generating: generating });
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
  // 记住写入用的元素：派发 Enter 必须作用于同一个输入框。
  // 页面可能同时存在隐藏搜索框/残留 textarea，朴素 querySelector 会选错。
  window.__qqInput = el;
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

        // 接收循环：按 id 唤醒挂起请求；连接关闭时清空挂起表，避免永久悬挂。
        // 流式增量由 Rust 轮询器直接推给订阅者，不经 WebSocket 事件回传。
        let pending_clone = pending.clone();
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
        let mut ready = false;
        while std::time::Instant::now() < deadline {
            if client.input_ready().await.unwrap_or(false) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if !ready {
            // 输入框迟迟不出现有两种原因，必须区分：
            // 1) 未登录——正常状态，交给后续 send 的 loginRequired 引导；
            // 2) 页面卡死/改版——连接不可用的坏状态，不该被缓存复用。
            let needs_login = client
                .login_state()
                .await
                .map(|(n, _, _, _)| n)
                .unwrap_or(false);
            if !needs_login {
                return Err(AppError::msg(
                    "DeepSeek 页面 20 秒内未就绪（未检测到输入框），请检查页面或重新登录。",
                ));
            }
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

        // 所有返回路径（成功/发送失败/超时/CDP 错误）都在这里统一摘除表项。
        // 接收循环先 remove 拿走 tx；这里再 remove 是幂等的。若响应永不到达，
        // 这一步把 tx 取回并 drop，避免 pending 表随超时请求无限增长。
        let result = self.call_inner(id, method, params, rx).await;
        self.pending.lock().await.remove(&id);
        result
    }

    async fn call_inner(
        &self,
        id: i64,
        method: &str,
        params: Value,
        rx: oneshot::Receiver<Value>,
    ) -> Result<Value, AppError> {
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

    /// 结构化登录态：前端据此弹引导，不再靠错误文案猜。
    pub async fn login_state(&self) -> Result<(bool, String, String, bool), AppError> {
        let raw = self.evaluate(LOGIN_STATE_JS).await?;
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        Ok((
            value.get("needsLogin").and_then(Value::as_bool).unwrap_or(false),
            value.get("reason").and_then(Value::as_str).unwrap_or("").to_string(),
            value.get("pageUrl").and_then(Value::as_str).unwrap_or("").to_string(),
            value.get("inputReady").and_then(Value::as_bool).unwrap_or(false),
        ))
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

    /// 等待 URL 出现会话 UUID（SPA 导航可能慢于回复完成判定）。
    /// 用于 done 时刻绑定 chat_id：切稳前拿到空串会导致会话永远无法接续。
    pub async fn current_chat_id_wait(&self, max_wait: Duration) -> String {
        let deadline = std::time::Instant::now() + max_wait;
        loop {
            if let Ok(id) = self.current_chat_id().await {
                if !id.is_empty() {
                    return id;
                }
            }
            if std::time::Instant::now() >= deadline {
                return String::new();
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// 把浏览器窗口移到屏幕中央、切到登录页并激活，供用户完成登录。
    /// 平时窗口被放在屏幕外，登录场景必须让它可见且获得焦点。
    pub async fn show_browser_window(&self) -> Result<(), AppError> {
        // 当前 CDP 连接就绑定在 DeepSeek 页面；若未登录但还停在聊天页，直接切登录页。
        if let Ok((needs_login, _, page_url, _)) = self.login_state().await {
            if needs_login && !(page_url.contains("sign_in") || page_url.contains("login")) {
                let _ = self
                    .call(
                        "Page.navigate",
                        json!({ "url": "https://chat.deepseek.com/sign_in" }),
                    )
                    .await;
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }

        let window = match self.call("Browser.getWindowForTarget", json!({})).await {
            Ok(v) => v,
            Err(_) => {
                // 旧版 CDP 要求显式 targetId 时再走页面列表（兼容性兜底）。
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
                let target_id = list
                    .iter()
                    .find(|p| {
                        p.get("url")
                            .and_then(Value::as_str)
                            .is_some_and(|u| u.contains("deepseek"))
                    })
                    .and_then(|p| p.get("id").and_then(Value::as_str))
                    .ok_or_else(|| {
                        AppError::msg("未找到 DeepSeek 页面，请稍后重试。".to_string())
                    })?
                    .to_string();
                self.call("Browser.getWindowForTarget", json!({ "targetId": target_id }))
                    .await?
            }
        };
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

        // 只移动边界还不够：Windows 上窗口可能仍在其它窗口后面。
        // Page.bringToFront 才真正激活标签页/窗口（实测 document.hasFocus() 变 true）。
        self.call("Page.bringToFront", json!({})).await?;
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
      var t = (list[i].textContent || '').trim();
      // 包含匹配：开关常带附加文案（如「深度思考（R1）」），精确相等会失配。
      if (t === label || t.indexOf(label) >= 0) return list[i];
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

    async fn read_reply(&self) -> Result<(bool, String, bool), AppError> {
        let raw = self.evaluate(READ_REPLY_JS).await?;
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        Ok((
            value.get("found").and_then(Value::as_bool).unwrap_or(false),
            value.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            value.get("generating").and_then(Value::as_bool).unwrap_or(false),
        ))
    }

    /// 写入文字并发送。发送前给现有消息打标，后续只认未打标的新消息。
    pub async fn send_message(
        self: &Arc<Self>,
        text: &str,
        files: &[String],
    ) -> Result<(), AppError> {
        let (needs_login, _reason, _page_url, input_ready) = self
            .login_state()
            .await
            .unwrap_or((false, String::new(), String::new(), false));
        if needs_login {
            return Err(AppError::login_required());
        }
        if !input_ready {
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

        // 给现有消息打标，并记录刚发出的文本作为新回复的身份锚点。
        let _ = self.evaluate(&mark_reply_js(&msg_json)).await?;

        // 复用写入阶段记住的输入框，确保 Enter 派发给刚写入 text 的同一个元素；
        // 页面导航或元素失效时回退到可见输入框探测，避免 NO_INPUT 后静默卡住。
        self.evaluate(
            r#"(function(){
              var el = window.__qqInput;
              if (!el || !el.isConnected) {{
                var groups = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
                el = null;
                for (var g = 0; g < groups.length && !el; g++) {{
                  var list = document.querySelectorAll(groups[g]);
                  for (var i = 0; i < list.length; i++) {{
                    var r = list[i].getBoundingClientRect();
                    var cs = getComputedStyle(list[i]);
                    if (!list[i].disabled && r.width >= 8 && r.height >= 8 &&
                        cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') {{
                      el = list[i]; break;
                    }}
                  }}
                }}
              }}
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

    /// 结束本轮：取出并清空订阅者，投递最终事件。
    /// 一次 take 完成"发送 + 摘除"，消费端随后 unsubscribe 不会残留悬挂。
    async fn finish(&self, event: StreamEvent) {
        if let Some(tx) = self.subscriber.lock().await.take() {
            let _ = tx.send(event);
        }
    }

    /// Rust 侧轮询回复并推送事件。新回复靠"未打标"识别，完成靠网页停止生成判定：
    /// 静默只用于确认文本不再变化，不再单独作为完成依据（思考/联网会长时间静默）。
    pub fn spawn_reply_poller(self: Arc<Self>, quiet_ms: u64) {
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(180);
            let mut last = String::new();
            let mut stable_ms: u64 = 0;
            // 连续读失败计数：页面改版/脚本异常时曾静默 continue 到 180s 超时，
            // 用户只看到"超时"，无法诊断。连续失败即发带原因的错误。
            let mut consecutive_errors = 0u32;
            let mut last_error: Option<String> = None;
            let tick = Duration::from_millis(250);
            // 发送触发 SPA 导航到会话页，先给页面一点时间稳定再读取。
            tokio::time::sleep(Duration::from_millis(600)).await;

            while std::time::Instant::now() < deadline {
                if !self.alive.load(Ordering::SeqCst) {
                    self.finish(StreamEvent::Error {
                        message: "浏览器连接已断开，请重试。".to_string(),
                        kind: None,
                    })
                    .await;
                    return;
                }
                if self.cancelled.load(Ordering::SeqCst) {
                    self.finish(StreamEvent::Error {
                        message: "已取消".to_string(),
                        kind: None,
                    })
                    .await;
                    return;
                }
                tokio::time::sleep(tick).await;
                let (found, text, generating) = match self.read_reply().await {
                    Ok(v) => {
                        consecutive_errors = 0;
                        v
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        // 保留首个错误（最有诊断价值），后续失败不覆盖。
                        if last_error.is_none() {
                            last_error = Some(e.message);
                        }
                        // 导航期偶尔失败属正常；连续 12 次（约 3s）说明脚本持续异常。
                        if consecutive_errors >= 12 {
                            let detail = last_error.unwrap_or_default();
                            self.finish(StreamEvent::Error {
                                message: format!("读取回复持续失败：{detail}"),
                                kind: None,
                            })
                            .await;
                            return;
                        }
                        continue;
                    }
                };
                // 新消息节点还没渲染（思考/搜索阶段正文为空），继续等。
                // 只在此时探测登录态：会话过期跳登录页时回复框必然消失，
                // 没必要每个 tick 都对全页做 innerText 扫描（会强制浏览器重排）。
                if !found {
                    if let Ok((needs_login, _, _, _)) = self.login_state().await {
                        if needs_login {
                            self.finish(StreamEvent::Error {
                                message: "DeepSeek 登录状态已失效，请重新登录。".to_string(),
                                kind: Some("loginRequired".to_string()),
                            })
                            .await;
                            return;
                        }
                    }
                    continue;
                }
                if text != last {
                    // 增量到达：推送完整文本，前端做替换（简单可靠）。
                    if let Some(tx) = self.subscriber.lock().await.as_ref() {
                        let _ = tx.send(StreamEvent::Delta { text: text.clone() });
                    }
                    stable_ms = 0;
                } else {
                    stable_ms += tick.as_millis() as u64;
                }
                last = text.clone();

                // 完成判定必须在空文本检查之前：纯图片回复或正文渲染为空时，
                // text 一直为空，若 continue 在前会跳过判定空转到 180s 超时。
                // generating 为 false 且文本已静默，就视为本轮完成（允许空文本）。
                if !generating && stable_ms >= quiet_ms {
                    self.finish(StreamEvent::Done { text }).await;
                    return;
                }
                // 仍在生成但正文尚未渲染（思考/搜索阶段）：无增量可推，继续等。
                if text.is_empty() {
                    continue;
                }
            }
            self.finish(StreamEvent::Error {
                message: "等待 DeepSeek 回复超时。".to_string(),
                kind: None,
            })
            .await;
        });
    }
}

/// 从 CDP HTTP 端点找到 DeepSeek 页面的 WebSocket 调试地址。
/// 记住本应用选中的 DeepSeek 标签 id：重连时优先复用同一标签，
/// 避免用户开着多个标签时每次重连选到不同页面（消息发 A、回复在 B 的根因）。
/// 这是进程级单例——应用只连一个浏览器、一个页面。
static REMEMBERED_TARGET: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

async fn find_page_socket(port: u16) -> Result<String, AppError> {
    let url = format!("http://127.0.0.1:{port}/json");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败：{e}")))?;
    let remembered = REMEMBERED_TARGET.get_or_init(|| std::sync::Mutex::new(None));

    let mut created = false;
    for attempt in 0..30 {
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(list) = resp.json::<Vec<Value>>().await {
                let deepseek_pages: Vec<&Value> = list
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("page"))
                    .filter(|item| {
                        item.get("url")
                            .and_then(Value::as_str)
                            .is_some_and(|u| u.contains("chat.deepseek.com"))
                    })
                    .collect();

                // 优先复用已记住的标签（只要它还开着）；用户标签一律不关闭。
                let remembered_id = remembered.lock().ok().and_then(|g| g.clone());
                let keep = remembered_id
                    .as_ref()
                    .and_then(|id| {
                        deepseek_pages
                            .iter()
                            .find(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str()))
                            .copied()
                    })
                    // 没有记住的标签时，取最新的 DeepSeek 页（列表顺序最新在后）。
                    .or_else(|| deepseek_pages.last().copied());

                if let Some(page) = keep {
                    if let Some(id) = page.get("id").and_then(Value::as_str) {
                        if let Ok(mut g) = remembered.lock() {
                            *g = Some(id.to_string());
                        }
                    }
                    if let Some(ws) = page.get("webSocketDebuggerUrl").and_then(Value::as_str) {
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
