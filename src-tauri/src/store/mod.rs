use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::error::AppError;
use crate::model::{Exchange, Session};

/// SQLite 仓储：桌面单用户场景，单连接 + Mutex 串行化即可。
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SqliteStore {
    pub fn init() -> Result<Self, AppError> {
        let dir = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("QuickQuestion");
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::msg(format!("无法创建数据目录：{e}")))?;
        let conn = Connection::open(dir.join("exchanges.db"))
            .map_err(|e| AppError::msg(format!("无法打开数据库：{e}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deepseek_chat_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS exchanges (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                answer_text TEXT NOT NULL DEFAULT '',
                image_names TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_exchanges_created ON exchanges(created_at DESC);",
        )
        .map_err(|e| AppError::msg(format!("建表失败：{e}")))?;

        // 旧库可能缺列：先补齐再加索引，否则 IF NOT EXISTS 对旧表无效、建索引会失败。
        let has_session: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('exchanges') WHERE name = 'session_id'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::msg(format!("检查表结构失败：{e}")))?;
        let has_chat: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'deepseek_chat_id'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::msg(format!("检查会话表结构失败：{e}")))?;
        if has_chat == 0 {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN deepseek_chat_id TEXT NOT NULL DEFAULT '';",
            )
            .map_err(|e| AppError::msg(format!("升级会话表结构失败：{e}")))?;
        }
        if has_session == 0 {
            conn.execute_batch("ALTER TABLE exchanges ADD COLUMN session_id TEXT NOT NULL DEFAULT '';")
                .map_err(|e| AppError::msg(format!("升级表结构失败：{e}")))?;
        }
        // 索引必须等列补齐之后再建，否则旧库上会因缺列而失败。
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_exchanges_session ON exchanges(session_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(deepseek_chat_id);",
        )
        .map_err(|e| AppError::msg(format!("建索引失败：{e}")))?;
        conn.execute_batch(
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at)
             SELECT 'legacy-' || id, substr(question_text, 1, 28), created_at, created_at
             FROM exchanges WHERE session_id = '';
             UPDATE exchanges SET session_id = 'legacy-' || id WHERE session_id = '';",
        )
        .map_err(|e| AppError::msg(format!("迁移历史数据失败：{e}")))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn create_session(&self, title: &str) -> Result<Session, AppError> {
        let now = now_ms();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            deepseek_chat_id: String::new(),
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, deepseek_chat_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session.id,
                session.title,
                session.created_at,
                session.updated_at,
                session.deepseek_chat_id
            ],
        )
        .map_err(|e| AppError::msg(format!("创建会话失败：{e}")))?;
        Ok(session)
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, created_at, updated_at, deepseek_chat_id
                 FROM sessions ORDER BY updated_at DESC",
            )
            .map_err(|e| AppError::msg(format!("查询会话失败：{e}")))?;
        let rows = stmt.query_map([], row_to_session)
            .map_err(|e| AppError::msg(format!("读取会话失败：{e}")))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| AppError::msg(format!("解析会话失败：{e}")))?);
        }
        Ok(result)
    }

    /// 按本地 id 取会话；不存在返回 None。
    pub fn find_session(&self, id: &str) -> Result<Option<Session>, AppError> {
        if id.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, created_at, updated_at, deepseek_chat_id
                 FROM sessions WHERE id = ?1",
            )
            .map_err(|e| AppError::msg(format!("查询会话失败：{e}")))?;
        let mut rows = stmt
            .query_map(params![id], row_to_session)
            .map_err(|e| AppError::msg(format!("读取会话失败：{e}")))?;
        match rows.next() {
            Some(row) => row
                .map(Some)
                .map_err(|e| AppError::msg(format!("解析会话失败：{e}"))),
            None => Ok(None),
        }
    }

    /// 按网页会话 UUID 反查本地会话（活跃会话定位用）。
    pub fn find_by_chat_id(&self, chat_id: &str) -> Result<Option<Session>, AppError> {
        if chat_id.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, created_at, updated_at, deepseek_chat_id
                 FROM sessions WHERE deepseek_chat_id = ?1",
            )
            .map_err(|e| AppError::msg(format!("查询会话绑定失败：{e}")))?;
        let mut rows = stmt
            .query_map(params![chat_id], row_to_session)
            .map_err(|e| AppError::msg(format!("读取会话绑定失败：{e}")))?;
        match rows.next() {
            Some(row) => row
                .map(Some)
                .map_err(|e| AppError::msg(format!("解析会话绑定失败：{e}"))),
            None => Ok(None),
        }
    }

    /// 把本地会话绑定到网页会话 UUID。
    pub fn bind_chat_id(&self, session_id: &str, chat_id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET deepseek_chat_id = ?2 WHERE id = ?1",
            params![session_id, chat_id],
        )
        .map_err(|e| AppError::msg(format!("绑定网页会话失败：{e}")))?;
        Ok(())
    }

    /// 删除会话及其全部问答。两步同事务：中途失败不会留下"会话没了、问答还在"的孤儿。
    pub fn delete_session(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| AppError::msg(format!("开启事务失败：{e}")))?;
        tx.execute("DELETE FROM exchanges WHERE session_id = ?1", params![id])
            .map_err(|e| AppError::msg(format!("删除会话内问答失败：{e}")))?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(|e| AppError::msg(format!("删除会话失败：{e}")))?;
        tx.commit()
            .map_err(|e| AppError::msg(format!("提交删除失败：{e}")))?;
        Ok(())
    }

    pub fn add(&self, exchange: &Exchange) -> Result<(), AppError> {
        let images = serde_json::to_string(&exchange.image_names)
            .map_err(|e| AppError::msg(format!("图片列表编码失败：{e}")))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO exchanges (id, session_id, created_at, question_text, answer_text, image_names)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                exchange.id,
                exchange.session_id,
                exchange.created_at,
                exchange.question_text,
                exchange.answer_text,
                images
            ],
        )
        .map_err(|e| AppError::msg(format!("保存问答失败：{e}")))?;
        // 会话按最近活动排序；标题在该会话第一条问答时补上。
        conn.execute(
            "UPDATE sessions SET updated_at = ?2,
                title = CASE WHEN title = '新会话' THEN substr(?3, 1, 28) ELSE title END
             WHERE id = ?1",
            params![exchange.session_id, exchange.created_at, exchange.question_text],
        )
        .map_err(|e| AppError::msg(format!("更新会话失败：{e}")))?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Exchange>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, created_at, question_text, answer_text, image_names
                 FROM exchanges ORDER BY created_at DESC",
            )
            .map_err(|e| AppError::msg(format!("查询失败：{e}")))?;
        let rows = stmt
            .query_map([], row_to_exchange)
            .map_err(|e| AppError::msg(format!("读取失败：{e}")))?;
        collect(rows)
    }

    /// 某个会话内的问答，按时间正序（对话流顺序）。
    pub fn list_by_session(&self, session_id: &str) -> Result<Vec<Exchange>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, created_at, question_text, answer_text, image_names
                 FROM exchanges WHERE session_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| AppError::msg(format!("查询会话问答失败：{e}")))?;
        let rows = stmt
            .query_map(params![session_id], row_to_exchange)
            .map_err(|e| AppError::msg(format!("读取会话问答失败：{e}")))?;
        collect(rows)
    }

    pub fn get(&self, id: &str) -> Result<Option<Exchange>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, created_at, question_text, answer_text, image_names
                 FROM exchanges WHERE id = ?1",
            )
            .map_err(|e| AppError::msg(format!("查询失败：{e}")))?;
        let mut rows = stmt
            .query_map(params![id], row_to_exchange)
            .map_err(|e| AppError::msg(format!("读取失败：{e}")))?;
        match rows.next() {
            Some(row) => row
                .map(Some)
                .map_err(|e| AppError::msg(format!("解析行失败：{e}"))),
            None => Ok(None),
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM exchanges WHERE id = ?1", params![id])
            .map_err(|e| AppError::msg(format!("删除失败：{e}")))?;
        Ok(())
    }
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        deepseek_chat_id: row.get(4)?,
    })
}

fn row_to_exchange(row: &rusqlite::Row<'_>) -> rusqlite::Result<Exchange> {
    let images_json: String = row.get(5)?;
    let image_names = serde_json::from_str(&images_json).unwrap_or_default();
    Ok(Exchange {
        id: row.get(0)?,
        session_id: row.get(1)?,
        created_at: row.get(2)?,
        question_text: row.get(3)?,
        answer_text: row.get(4)?,
        image_names,
    })
}

fn collect(
    rows: impl Iterator<Item = rusqlite::Result<Exchange>>,
) -> Result<Vec<Exchange>, AppError> {
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| AppError::msg(format!("解析行失败：{e}")))?);
    }
    Ok(result)
}

/// 生成复制用的 Markdown 文本：`## 问题\n回复`。
/// 图片是独立附件、无法定位到文字中间，故占位符按顺序追加到问题末尾。
pub fn to_markdown(exchange: &Exchange) -> String {
    let mut question = exchange.question_text.clone();
    if !exchange.image_names.is_empty() {
        let placeholders = (1..=exchange.image_names.len())
            .map(|i| format!("[图片{}]", i))
            .collect::<Vec<_>>()
            .join(" ");
        question = format!("{question} {placeholders}");
    }
    format!("## {}\n{}", question, exchange.answer_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(image_names: Vec<String>) -> Exchange {
        Exchange {
            id: "x".into(),
            session_id: "s1".into(),
            created_at: 0,
            question_text: "这是问题".into(),
            answer_text: "这是回复".into(),
            image_names,
        }
    }

    fn memory_store() -> SqliteStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY, title TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deepseek_chat_id TEXT NOT NULL DEFAULT '');
             CREATE TABLE exchanges (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                question_text TEXT NOT NULL, answer_text TEXT NOT NULL DEFAULT '',
                image_names TEXT NOT NULL DEFAULT '[]');",
        )
        .unwrap();
        SqliteStore {
            conn: Mutex::new(conn),
        }
    }

    #[test]
    fn markdown_format_without_images() {
        assert_eq!(to_markdown(&sample(vec![])), "## 这是问题\n这是回复");
    }

    #[test]
    fn markdown_appends_image_placeholders() {
        let ex = sample(vec!["a.png".into(), "b.png".into()]);
        assert_eq!(
            to_markdown(&ex),
            "## 这是问题 [图片1] [图片2]\n这是回复"
        );
    }

    #[test]
    fn sqlite_add_list_get_delete() {
        let store = memory_store();
        let session = store.create_session("新会话").unwrap();
        let mut ex = sample(vec![]);
        ex.id = "abc".into();
        ex.session_id = session.id.clone();
        store.add(&ex).unwrap();

        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.list_by_session(&session.id).unwrap().len(), 1);
        assert_eq!(store.get("abc").unwrap().unwrap().question_text, "这是问题");

        // 首条问答应把「新会话」这个占位标题替换掉
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions[0].title, "这是问题");

        store.delete("abc").unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn delete_session_removes_its_exchanges() {
        let store = memory_store();
        let a = store.create_session("A").unwrap();
        let b = store.create_session("B").unwrap();
        let mut one = sample(vec![]);
        one.id = "1".into();
        one.session_id = a.id.clone();
        let mut two = sample(vec![]);
        two.id = "2".into();
        two.session_id = b.id.clone();
        store.add(&one).unwrap();
        store.add(&two).unwrap();

        store.delete_session(&a.id).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.list().unwrap()[0].id, "2");
    }

    #[test]
    fn list_is_ordered_newest_first() {
        let store = memory_store();
        let s = store.create_session("S").unwrap();
        let mut older = sample(vec![]);
        older.id = "old".into();
        older.session_id = s.id.clone();
        older.created_at = 100;
        let mut newer = sample(vec![]);
        newer.id = "new".into();
        newer.session_id = s.id.clone();
        newer.created_at = 200;
        store.add(&older).unwrap();
        store.add(&newer).unwrap();

        let list = store.list().unwrap();
        assert_eq!(list[0].id, "new");
        assert_eq!(list[1].id, "old");
        // 会话内按时间正序
        let in_session = store.list_by_session(&s.id).unwrap();
        assert_eq!(in_session[0].id, "old");
        assert_eq!(in_session[1].id, "new");
    }
}
