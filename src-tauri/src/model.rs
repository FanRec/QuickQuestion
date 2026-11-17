use serde::Serialize;

/// 浏览器与 CDP 连接的可观测状态，供前端展示与诊断。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub ready: bool,
    pub port: u16,
    pub page_url: String,
    pub input_ready: bool,
}
