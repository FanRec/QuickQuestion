use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 应用设置。端口/静默窗口存 Rust 侧 JSON；主题是纯前端表现，存 localStorage。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 缺字段时取默认值：旧版本 settings.json 只有部分字段，
    /// 若任一必填字段缺失会导致整份反序列化失败、全量重置。
    #[serde(default = "default_port")]
    pub browser_port: u16,
    #[serde(default = "default_quiet_ms")]
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

fn default_port() -> u16 {
    9222
}

fn default_quiet_ms() -> u64 {
    900
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

#[derive(Clone)]
pub struct ConfigService {
    path: std::path::PathBuf,
}

impl ConfigService {
    pub fn new() -> Self {
        let dir = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
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

    /// 只更新启动恢复点，不动其他字段。last_session_id 的单一写入口。
    pub fn set_last_session(&self, id: &str) -> Result<(), AppError> {
        let mut settings = self.load();
        settings.last_session_id = id.to_string();
        self.save(&settings)
    }

    /// CAS 回滚恢复点：仅当当前值仍等于 expected（本轮写入的值、期间未被用户改动）
    /// 时才写回 target。避免回复失败时把用户期间主动切换的会话覆盖成旧快照。
    /// 返回是否实际写入。
    pub fn restore_last_session_if(&self, expected: &str, target: &str) -> Result<bool, AppError> {
        let mut settings = self.load();
        if settings.last_session_id != expected {
            return Ok(false);
        }
        settings.last_session_id = target.to_string();
        self.save(&settings)?;
        Ok(true)
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
    // 上限与设置页输入框的 max 对齐；非负已由 u64 的类型保证，无需再钳一次。
    s.bubble_hide_secs = s.bubble_hide_secs.min(600);
    s.popup_hide_secs = s.popup_hide_secs.min(600);
    if s.hotkey.trim().is_empty() {
        s.hotkey = "Alt+Q".to_string();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧版本 settings.json 只有部分字段：缺 browser_port/quiet_ms 时
    /// 必须靠 serde(default) 反序列化成功，而不是整份回退到默认值。
    #[test]
    fn partial_settings_json_keeps_present_fields() {
        let json = r#"{"systemPrompt":"我的长期设定","lastSessionId":"sess-1"}"#;
        let s: Settings = serde_json::from_str(json).expect("缺字段应仍能反序列化");
        assert_eq!(s.system_prompt, "我的长期设定");
        assert_eq!(s.last_session_id, "sess-1");
        // 缺失字段取 default，而非把整份设置重置。
        assert_eq!(s.browser_port, 9222);
        assert_eq!(s.quiet_ms, 900);
    }

    #[test]
    fn normalize_clamps_values() {
        let s = Settings {
            browser_port: 0,
            quiet_ms: 999999,
            bubble_hide_secs: 9999,
            popup_hide_secs: 9999,
            hotkey: "  ".into(),
            ..Settings::default()
        };
        let n = normalize(s);
        assert_eq!(n.browser_port, 9222);
        assert_eq!(n.quiet_ms, 900);
        assert_eq!(n.bubble_hide_secs, 600);
        assert_eq!(n.popup_hide_secs, 600);
        assert_eq!(n.hotkey, "Alt+Q");
    }
}
