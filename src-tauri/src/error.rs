use serde::Serialize;

/// 面向前端的统一错误类型；message 为可直接展示的中文提示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub message: String,
    /// 结构化错误码：前端据此决定行为（如弹登录引导），不再靠中文文案猜。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl AppError {
    pub fn msg<S: Into<String>>(message: S) -> Self {
        Self {
            message: message.into(),
            kind: None,
        }
    }

    pub fn with_kind<S: Into<String>, K: Into<String>>(message: S, kind: K) -> Self {
        Self {
            message: message.into(),
            kind: Some(kind.into()),
        }
    }

    pub fn login_required() -> Self {
        Self::with_kind(
            "DeepSeek 尚未登录，请点击下方“去登录”完成登录后再发送。",
            "loginRequired",
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}
