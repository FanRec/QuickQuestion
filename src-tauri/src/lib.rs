pub mod browser;
pub mod cdp;
mod commands;
mod error;
pub mod model;

use std::sync::Arc;
use tokio::sync::Mutex;

use browser::{BrowserManager, DEFAULT_PORT};
use cdp::CdpClient;
use error::AppError;

/// 应用共享状态：浏览器进程管理与复用的 CDP 连接。
pub struct AppState {
    pub browser: BrowserManager,
    pub cdp: Mutex<Option<Arc<CdpClient>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            browser: BrowserManager::new(DEFAULT_PORT),
            cdp: Mutex::new(None),
        }
    }

    /// 确保浏览器与 CDP 连接就绪，返回可复用的客户端引用。
    pub async fn ensure_cdp(&self) -> Result<Arc<CdpClient>, AppError> {
        let mut guard = self.cdp.lock().await;
        if guard.is_none() {
            self.browser.ensure_ready().await?;
            *guard = Some(Arc::new(CdpClient::connect(self.browser.port()).await?));
        }
        Ok(guard.as_ref().unwrap().clone())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![commands::ping, commands::browser_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
