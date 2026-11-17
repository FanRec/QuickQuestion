pub mod browser;
pub mod cdp;
mod commands;
mod error;
pub mod model;
mod store;

use std::sync::Arc;
use tokio::sync::Mutex;

use browser::{BrowserManager, DEFAULT_PORT};
use cdp::CdpClient;
use error::AppError;
use store::SqliteStore;

/// 应用共享状态：浏览器进程管理、复用的 CDP 连接、问答仓储。
pub struct AppState {
    pub browser: BrowserManager,
    pub cdp: Mutex<Option<Arc<CdpClient>>>,
    pub store: SqliteStore,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        Ok(Self {
            browser: BrowserManager::new(DEFAULT_PORT),
            cdp: Mutex::new(None),
            store: SqliteStore::init()?,
        })
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
    let state = Arc::new(AppState::new().expect("初始化数据库失败"));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::browser_status,
            commands::send_message,
            commands::list_exchanges,
            commands::get_exchange,
            commands::delete_exchange,
            commands::copy_markdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
