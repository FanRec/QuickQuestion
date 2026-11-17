pub mod browser;
pub mod cdp;
mod commands;
mod config;
mod error;
pub mod model;
mod store;

use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use browser::BrowserManager;
use cdp::CdpClient;
use config::ConfigService;
use error::AppError;
use store::SqliteStore;

/// 应用共享状态：浏览器进程管理、复用的 CDP 连接、问答仓储、配置。
pub struct AppState {
    pub browser: BrowserManager,
    pub cdp: Mutex<Option<Arc<CdpClient>>>,
    pub store: SqliteStore,
    pub config: ConfigService,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let config = ConfigService::new();
        // 端口在启动时读取；运行中修改需重启应用生效。
        let port = config.load().browser_port;
        Ok(Self {
            browser: BrowserManager::new(port),
            cdp: Mutex::new(None),
            store: SqliteStore::init()?,
            config,
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
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::browser_status,
            commands::send_message,
            commands::list_exchanges,
            commands::get_exchange,
            commands::delete_exchange,
            commands::copy_markdown,
            commands::get_settings,
            commands::update_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_orb = MenuItem::new(app, "显示悬浮球", true, None::<&str>)?;
    let open_main = MenuItem::new(app, "打开主窗口", true, None::<&str>)?;
    let quit = MenuItem::new(app, "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&show_orb)
        .item(&open_main)
        .item(&quit)
        .build()?;

    let show_orb_id = show_orb.id().clone();
    let open_main_id = open_main.id().clone();
    let quit_id = quit.id().clone();
    let icon = app.default_window_icon().cloned().expect("应用图标");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            id if id == show_orb_id.as_ref() => {
                if let Some(win) = app.get_webview_window("orb") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            id if id == open_main_id.as_ref() => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            id if id == quit_id.as_ref() => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.browser.shutdown();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("orb") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("qq://tray-show-orb", ());
            }
        })
        .build(app)?;

    Ok(())
}
