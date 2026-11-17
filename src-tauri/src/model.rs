use serde::{Deserialize, Serialize};

/// 浏览器与 CDP 连接的可观测状态，供前端展示与诊断。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub ready: bool,
    pub port: u16,
    pub page_url: String,
    pub input_ready: bool,
}

/// 一条完整问答。单一数据源实体，M4 起持久化到 SQLite。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub id: String,
    pub created_at: i64,
    pub question_text: String,
    pub answer_text: String,
    pub image_names: Vec<String>,
}
