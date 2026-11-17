use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::model::BrowserStatus;
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
