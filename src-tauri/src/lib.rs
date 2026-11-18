pub mod browser;
pub mod cdp;
mod commands;
mod config;
mod error;
pub mod model;
mod store;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
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
    /// 全局发送互斥：一个问答周期（发送到 done/error）内拒绝第二次提交。
    pub sending: AtomicBool,
}

impl AppState {
    /// 抢到发送权返回 true；已被占用返回 false。
    pub fn try_begin_send(&self) -> bool {
        self.sending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn end_send(&self) {
        self.sending.store(false, Ordering::SeqCst);
    }
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
            sending: AtomicBool::new(false),
        })
    }

    /// 确保浏览器与 CDP 连接就绪，返回可复用的客户端引用。
    pub async fn ensure_cdp(&self) -> Result<Arc<CdpClient>, AppError> {
        let mut guard = self.cdp.lock().await;
        let dead = guard.as_ref().is_some_and(|c| !c.is_alive());
        if guard.is_none() || dead {
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
            // 全局唤起输入条：快捷键来自设置（默认 Alt+Q）。
            // 注册失败（被别的软件占用）不能让应用起不来，只记日志。
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri_plugin_global_shortcut::ShortcutState;

                let hotkey = app
                    .try_state::<Arc<AppState>>()
                    .map(|s| s.config.load().hotkey)
                    .unwrap_or_else(|| "Alt+Q".to_string());
                let normalized = hotkey.to_lowercase().replace(' ', "");
                if !normalized.is_empty() {
                    let builder = tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                let _ = app.emit("qq://hotkey-input", ());
                            }
                        })
                        .with_shortcuts([normalized.as_str()]);
                    match builder {
                        Ok(b) => {
                            if let Err(e) = app.handle().plugin(b.build()) {
                                eprintln!("注册全局快捷键失败：{e}");
                            }
                        }
                        Err(e) => eprintln!("全局快捷键格式无效（{hotkey}）：{e}"),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::browser_status,
            commands::send_message,
            commands::cancel_message,
            commands::list_exchanges,
            commands::list_sessions,
            commands::create_session,
            commands::active_session,
            commands::is_sending,
            commands::remember_session,
            commands::delete_session,
            commands::get_exchange,
            commands::delete_exchange,
            commands::copy_markdown,
            commands::save_temp_image,
            commands::open_login_window,
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
                if let Some(win) = app.get_webview_window("panel") {
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
                if let Some(win) = app.get_webview_window("panel") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
