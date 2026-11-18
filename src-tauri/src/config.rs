use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 应用设置。端口/静默窗口存 Rust 侧 JSON；主题是纯前端表现，存 localStorage。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub browser_port: u16,
    pub quiet_ms: u64,
    /// 会话首条问答前注入的长期设定；为空则不注入。
    #[serde(default)]
    pub system_prompt: String,
    /// 上次退出前选中的本地会话，启动时恢复。
    #[serde(default)]
    pub last_session_id: String,
    /// 全局唤起快捷键，格式如 "Alt+Q"；留空则不注册。
    #[serde(default)]
    pub hotkey: String,
    /// 回复气泡自动消失秒数；0 表示永不消失。
    #[serde(default = "default_bubble_hide")]
    pub bubble_hide_secs: u64,
    /// 独立输入条整体自动收起秒数；0 表示永不收起。
    #[serde(default)]
    pub popup_hide_secs: u64,
}

fn default_bubble_hide() -> u64 {
    5
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            browser_port: 9222,
            quiet_ms: 900,
            system_prompt: String::new(),
            last_session_id: String::new(),
            hotkey: "Alt+Q".to_string(),
            bubble_hide_secs: 5,
            popup_hide_secs: 0,
        }
    }
}

pub struct ConfigService {
    path: std::path::PathBuf,
}

impl ConfigService {
    pub fn new() -> Self {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join("QuickQuestion");
        Self {
            path: dir.join("settings.json"),
        }
    }

    pub fn load(&self) -> Settings {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .map(normalize)
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &Settings) -> Result<(), AppError> {
        let settings = normalize(settings.clone());
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::msg(format!("无法创建配置目录：{e}")))?;
        }
        let json = serde_json::to_string_pretty(&settings)
            .map_err(|e| AppError::msg(format!("配置编码失败：{e}")))?;
        std::fs::write(&self.path, json)
            .map_err(|e| AppError::msg(format!("保存设置失败：{e}")))?;
        Ok(())
    }
}

fn normalize(mut s: Settings) -> Settings {
    if s.browser_port == 0 {
        s.browser_port = 9222;
    }
    if !(200..=5000).contains(&s.quiet_ms) {
        s.quiet_ms = 900;
    }
    if s.hotkey.trim().is_empty() {
        s.hotkey = "Alt+Q".to_string();
    }
    s
}
