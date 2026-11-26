use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Wry};

use crate::AppState;

/// 托盘菜单项由后端持有：悬浮球可见性一变就同步改文案，
/// 不能让每个入口自己 show/hide、各记一份状态。
#[derive(Clone)]
struct TrayMenuState {
    toggle_orb: MenuItem<Wry>,
}

/// 托盘/菜单唤起窗口：必须先 unminimize，最小化状态下 show() 不会还原窗口。
/// 与前端 windows.ts 的 showWindow 保持同一语义，避免两处行为漂移。
fn restore_window(win: &tauri::WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 悬浮球显示状态的唯一写入口：窗口可见性与托盘文案一起改。
/// 托盘菜单、托盘左键、前端右键隐藏、Alt+F4 全走这里，防止菜单和实际状态漂移。
pub fn set_panel_visible(app: &AppHandle, visible: bool) {
    if let Some(win) = app.get_webview_window("panel") {
        if visible {
            restore_window(&win);
        } else {
            let _ = win.hide();
        }
    }
    if let Some(state) = app.try_state::<TrayMenuState>() {
        let label = if visible { "隐藏悬浮球" } else { "显示悬浮球" };
        let _ = state.toggle_orb.set_text(label);
    }
    // 通知前端收起临时菜单等附属 UI；前端主动触发时也会收到，幂等。
    let _ = app.emit("qq://panel-visibility", visible);
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // 启动时面板窗口必定由前端自动显示，所以初始文案是「隐藏」。
    let toggle_orb = MenuItem::new(app, "隐藏悬浮球", true, None::<&str>)?;
    let open_main = MenuItem::new(app, "打开主窗口", true, None::<&str>)?;
    let quit = MenuItem::new(app, "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&toggle_orb)
        .item(&open_main)
        .item(&quit)
        .build()?;

    let toggle_orb_id = toggle_orb.id().clone();
    let open_main_id = open_main.id().clone();
    let quit_id = quit.id().clone();
    app.manage(TrayMenuState {
        toggle_orb: toggle_orb.clone(),
    });
    let icon = app.default_window_icon().cloned().expect("应用图标");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            id if id == toggle_orb_id.as_ref() => {
                let visible = app
                    .get_webview_window("panel")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                set_panel_visible(app, !visible);
            }
            id if id == open_main_id.as_ref() => {
                if let Some(win) = app.get_webview_window("main") {
                    restore_window(&win);
                }
            }
            id if id == quit_id.as_ref() => {
                // 注册时 manage 的是 Arc<AppState>（见 run() 的 .manage），Tauri 按 TypeId
                // 精确匹配状态，这里必须取同样的类型，否则恒为 None、浏览器不回收。
                if let Some(state) = app.try_state::<Arc<AppState>>() {
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
                set_panel_visible(tray.app_handle(), true);
            }
        })
        .build(app)?;

    Ok(())
}
