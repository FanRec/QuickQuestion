use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::cdp::StreamEvent;
use crate::error::AppError;
use crate::model::{BrowserStatus, Exchange};
use crate::store::to_markdown;
use crate::AppState;

/// 健康检查命令；M0 用于验证 IPC 链路。
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

/// 确保浏览器与 CDP 就绪，返回可展示的连接状态。
#[tauri::command]
pub async fn browser_status(state: State<'_, Arc<AppState>>) -> Result<BrowserStatus, AppError> {
    let cdp = state.ensure_cdp().await?;
    let page_url = cdp.current_url().await.unwrap_or_default();
    let input_ready = cdp.input_ready().await.unwrap_or(false);
    Ok(BrowserStatus {
        ready: true,
        port: state.browser.port(),
        page_url,
        input_ready,
    })
}

/// 发送消息。立即返回 exchangeId；后续增量经 `qq://stream` 事件推送。
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    text: String,
    files: Vec<String>,
) -> Result<String, AppError> {
    let cdp = state.ensure_cdp().await?;
    // 必须先订阅再发送，避免事件在订阅之前到达而丢失。
    let mut rx = cdp.subscribe().await;

    let id = Uuid::new_v4().to_string();
    let exchange_id = id.clone();
    let app_for_task = app.clone();

    cdp.send_message(&text, &files).await?;

    // 消费流式事件并转发给前端。
    let state_for_task = state.inner().clone();
    let cdp_for_task = cdp.clone();
    let question_text = text.clone();
    let image_names = files
        .iter()
        .map(|p| std::path::Path::new(p))
        .filter_map(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Delta { text } => {
                    let _ = app_for_task.emit(
                        "qq://stream",
                        serde_json::json!({
                            "type": "delta",
                            "exchangeId": exchange_id,
                            "text": text,
                        }),
                    );
                }
                StreamEvent::Done { text } => {
                    let answer = text;
                    let created_at = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    if let Err(e) = state_for_task.store.add(&Exchange {
                        id: exchange_id.clone(),
                        created_at,
                        question_text: question_text.clone(),
                        answer_text: answer.clone(),
                        image_names: image_names.clone(),
                    }) {
                        let _ = app_for_task.emit(
                            "qq://stream",
                            serde_json::json!({
                                "type": "error",
                                "exchangeId": exchange_id,
                                "message": format!("保存历史失败：{}", e.message),
                            }),
                        );
                    }
                    let _ = app_for_task.emit(
                        "qq://stream",
                        serde_json::json!({
                            "type": "done",
                            "exchangeId": exchange_id,
                            "text": answer,
                        }),
                    );
                    cdp_for_task.unsubscribe().await;
                    break;
                }
                StreamEvent::Error { message } => {
                    let _ = app_for_task.emit(
                        "qq://stream",
                        serde_json::json!({
                            "type": "error",
                            "exchangeId": exchange_id,
                            "message": message,
                        }),
                    );
                    cdp_for_task.unsubscribe().await;
                    break;
                }
            }
        }
    });

    Ok(id)
}

/// 列出全部问答（倒序），悬浮列表与主窗口左栏共用。
#[tauri::command]
pub fn list_exchanges(state: State<'_, Arc<AppState>>) -> Result<Vec<Exchange>, AppError> {
    state.store.list()
}

/// 获取单条问答详情。
#[tauri::command]
pub fn get_exchange(state: State<'_, Arc<AppState>>, id: String) -> Result<Option<Exchange>, AppError> {
    state.store.get(&id)
}

/// 删除一条问答。
#[tauri::command]
pub fn delete_exchange(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.store.delete(&id)
}

/// 生成复制文本：`## 问题\n回复`；剪贴板写入由前端完成。
#[tauri::command]
pub fn copy_markdown(state: State<'_, Arc<AppState>>, id: String) -> Result<String, AppError> {
    let exchange = state
        .store
        .get(&id)?
        .ok_or_else(|| AppError::msg("未找到该问答。"))?;
    Ok(to_markdown(&exchange))
}
