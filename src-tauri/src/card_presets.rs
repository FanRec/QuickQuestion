use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;

const MAX_CSS_BYTES: u64 = 64 * 1024;
const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024;
const RESERVED_IDS: [&str; 2] = ["classic", "plain"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub id: String,
    pub label: String,
    pub description: String,
}

/// 用户预设目录服务。路径与粘贴图、assetProtocol scope 保持一致：
/// %LOCALAPPDATA%/QuickQuestion/card-presets。
#[derive(Debug, Clone)]
pub struct CardPresets {
    root: PathBuf,
}

impl CardPresets {
    pub fn new() -> Self {
        let root = dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("QuickQuestion")
            .join("card-presets");
        Self { root }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    /// 列出本地预设。目录不存在是正常初始状态，不是错误。
    /// 非法目录名（含路径分隔符或占用内置 id）跳过，避免选择题出现歧义。
    pub fn list(&self) -> Result<Vec<PresetInfo>, AppError> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&self.root)
            .map_err(|e| AppError::msg(format!("读取预设目录失败：{e}")))?;
        let mut result = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !valid_id(&id) {
                continue;
            }
            let (label, description) = self.meta(&path, &id);
            result.push(PresetInfo {
                id,
                label,
                description,
            });
        }
        result.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(result)
    }

    /// 元数据损坏时以目录名作为 label，不阻止整条预设被加载。
    fn meta(&self, dir: &Path, id: &str) -> (String, String) {
        let parsed = fs::read_to_string(dir.join("preset.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        match parsed {
            Some(value) => {
                let label = value
                    .get("label")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(id)
                    .to_string();
                let description = value
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                (label, description)
            }
            None => (id.to_string(), String::new()),
        }
    }

    /// 返回可直接追加到 BASE_CARD_CSS 之后的 CSS。
    /// 资源文件先转成 data URI 再交给渲染器：SVG-as-image 里外链不会加载。
    pub fn load_css(&self, id: &str) -> Result<String, AppError> {
        if !valid_id(id) {
            return Err(AppError::msg("预设 ID 不合法。"));
        }
        let dir = self.root.join(id);
        let tokens_path = dir.join("tokens.css");
        let meta = fs::metadata(&tokens_path)
            .map_err(|_| AppError::msg(format!("预设“{id}”缺少 tokens.css。")))?;
        if meta.len() > MAX_CSS_BYTES {
            return Err(AppError::msg(format!("预设“{id}”的 tokens.css 超过 64 KiB。")));
        }
        let tokens = fs::read_to_string(&tokens_path)
            .map_err(|e| AppError::msg(format!("读取预设样式失败：{e}")))?;

        let mut assets = String::new();
        for (file, var) in [
            ("background.png", "--qq-frame-bg"),
            ("top.svg", "--qq-decor-top-image"),
            ("bottom.svg", "--qq-decor-bottom-image"),
            ("mascot.png", "--qq-mascot-image"),
        ] {
            let path = dir.join(file);
            if !path.exists() {
                continue;
            }
            let bytes = fs::read(&path)
                .map_err(|e| AppError::msg(format!("读取预设资源 {file} 失败：{e}")))?;
            if bytes.len() as u64 > MAX_ASSET_BYTES {
                return Err(AppError::msg(format!("预设资源 {file} 超过 2 MiB。")));
            }
            let mime = if file.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "image/png"
            };
            let encoded = base64_encode(&bytes);
            let value = if var == "--qq-frame-bg" {
                format!("url(\"data:{mime};base64,{encoded}\") center/cover no-repeat")
            } else {
                format!("url(\"data:{mime};base64,{encoded}\")")
            };
            // 基线里的暗色 token 用了 .qq-frame[data-qq-theme="dark"]，
            // 单写 .qq-frame 会被更高优先级覆盖，暗色主题永远看不到用户图片。
            // 两种选择器都写，tokens.css 仍能按同样的优先级覆盖资源默认值。
            let decl = format!("{var}:{value};");
            assets.push_str(&format!(
                ".qq-frame{{{decl}}}.qq-frame[data-qq-theme=\"dark\"]{{{decl}}}\n"
            ));
        }
        Ok(format!("{assets}\n{tokens}"))
    }

    /// 打开目录供用户放置预设；首次调用时创建目录。
    pub fn open_dir(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.root)
            .map_err(|e| AppError::msg(format!("创建预设目录失败：{e}")))?;
        tauri_plugin_opener::open_path(self.root.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| AppError::msg(format!("打开预设目录失败：{e}")))
    }
}

/// 标准 base64 编码。只用于把本地资源塞进 data URI；
/// 不为此引入新依赖（离线环境无法拉取 crate）。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    match data.len() - i {
        1 => {
            let n = (data[i] as u32) << 16;
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push_str("==");
        }
        2 => {
            let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// 目录名即预设 id：只允许 ASCII 字母数字、连字符与下划线，且不能占用内置 id。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !RESERVED_IDS.contains(&id)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qq-card-preset-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("创建测试目录失败");
        root
    }

    #[test]
    fn base64_matches_standard_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn rejects_traversal_and_reserved_ids() {
        assert!(!valid_id("../settings"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("classic"));
        assert!(!valid_id("plain"));
        assert!(!valid_id(""));
        assert!(valid_id("my_style-1"));
    }

    #[test]
    fn missing_tokens_css_reports_explicit_error() {
        let svc = CardPresets::with_root(temp_root("missing"));
        fs::create_dir_all(svc.root.join("foo")).unwrap();
        let err = svc.load_css("foo").unwrap_err();
        assert!(err.message.contains("tokens.css"), "{}", err.message);
    }

    #[test]
    fn inlines_assets_as_data_uris() {
        let root = temp_root("inline");
        let dir = root.join("mine");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tokens.css"), ".qq-frame{--qq-title:#123456}").unwrap();
        fs::write(dir.join("top.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        fs::write(dir.join("background.png"), b"png-bytes").unwrap();
        let css = CardPresets::with_root(root).load_css("mine").unwrap();
        assert!(css.contains("--qq-decor-top-image:url(\"data:image/svg+xml;base64,"));
        assert!(css.contains("--qq-frame-bg:url(\"data:image/png;base64,"));
        assert!(css.contains(".qq-frame[data-qq-theme=\"dark\"]{--qq-frame-bg:"));
        assert!(css.contains("--qq-title:#123456"));
    }

    #[test]
    fn list_reads_label_and_skips_invalid_dirs() {
        let root = temp_root("list");
        fs::create_dir_all(root.join("good")).unwrap();
        fs::write(
            root.join("good").join("preset.json"),
            r#"{"label":"我的样式","description":"测试"}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("bad name")).unwrap();
        fs::create_dir_all(root.join("classic")).unwrap();
        let list = CardPresets::with_root(root).list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "good");
        assert_eq!(list[0].label, "我的样式");
        assert_eq!(list[0].description, "测试");
    }

    #[test]
    fn oversized_css_is_rejected() {
        let root = temp_root("large");
        let dir = root.join("heavy");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tokens.css"), vec![b'x'; 65 * 1024]).unwrap();
        let err = CardPresets::with_root(root).load_css("heavy").unwrap_err();
        assert!(err.message.contains("64 KiB"), "{}", err.message);
    }
}
