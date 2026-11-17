use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 应用设置。端口/静默窗口存 Rust 侧 JSON；主题是纯前端表现，存 localStorage。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub browser_port: u16,
    pub quiet_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            browser_port: 9222,
            quiet_ms: 900,
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
    s
}
