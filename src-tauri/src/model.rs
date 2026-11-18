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

/// 一个会话：一次「新对话」从开始到结束之间的问答集合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 对应的 DeepSeek 网页会话 UUID；空表示尚未与网页会话建立绑定（如历史迁移数据）。
    #[serde(default)]
    pub deepseek_chat_id: String,
}

/// 一条完整问答，归属于某个会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub id: String,
    pub session_id: String,
    pub created_at: i64,
    pub question_text: String,
    pub answer_text: String,
    pub image_names: Vec<String>,
}
