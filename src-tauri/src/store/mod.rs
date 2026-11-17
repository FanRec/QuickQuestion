use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::error::AppError;
use crate::model::Exchange;

/// SQLite 仓储：桌面单用户场景，单连接 + Mutex 串行化即可。
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn init() -> Result<Self, AppError> {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join("QuickQuestion");
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::msg(format!("无法创建数据目录：{e}")))?;
        let conn = Connection::open(dir.join("exchanges.db"))
            .map_err(|e| AppError::msg(format!("无法打开数据库：{e}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS exchanges (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                answer_text TEXT NOT NULL DEFAULT '',
                image_names TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_exchanges_created ON exchanges(created_at DESC);",
        )
        .map_err(|e| AppError::msg(format!("建表失败：{e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn add(&self, exchange: &Exchange) -> Result<(), AppError> {
        let images = serde_json::to_string(&exchange.image_names)
            .map_err(|e| AppError::msg(format!("图片列表编码失败：{e}")))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO exchanges (id, created_at, question_text, answer_text, image_names)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                exchange.id,
                exchange.created_at,
                exchange.question_text,
                exchange.answer_text,
                images
            ],
        )
        .map_err(|e| AppError::msg(format!("保存问答失败：{e}")))?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Exchange>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, question_text, answer_text, image_names
                 FROM exchanges ORDER BY created_at DESC",
            )
            .map_err(|e| AppError::msg(format!("查询失败：{e}")))?;
        let rows = stmt
            .query_map([], |row| row_to_exchange(row))
            .map_err(|e| AppError::msg(format!("读取失败：{e}")))?;
        collect(rows)
    }

    pub fn get(&self, id: &str) -> Result<Option<Exchange>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, question_text, answer_text, image_names
                 FROM exchanges WHERE id = ?1",
            )
            .map_err(|e| AppError::msg(format!("查询失败：{e}")))?;
        let mut rows = stmt
            .query_map(params![id], |row| row_to_exchange(row))
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

fn row_to_exchange(row: &rusqlite::Row<'_>) -> rusqlite::Result<Exchange> {
    let images_json: String = row.get(4)?;
    let image_names = serde_json::from_str(&images_json).unwrap_or_default();
    Ok(Exchange {
        id: row.get(0)?,
        created_at: row.get(1)?,
        question_text: row.get(2)?,
        answer_text: row.get(3)?,
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
            created_at: 0,
            question_text: "这是问题".into(),
            answer_text: "这是回复".into(),
            image_names,
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
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE exchanges (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
                question_text TEXT NOT NULL, answer_text TEXT NOT NULL DEFAULT '',
                image_names TEXT NOT NULL DEFAULT '[]');",
        )
        .unwrap();
        let store = SqliteStore {
            conn: Mutex::new(conn),
        };
        let mut ex = sample(vec![]);
        ex.id = "abc".into();
        store.add(&ex).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "abc");
        assert_eq!(store.get("abc").unwrap().unwrap().question_text, "这是问题");
        store.delete("abc").unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn list_is_ordered_newest_first() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE exchanges (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
                question_text TEXT NOT NULL, answer_text TEXT NOT NULL DEFAULT '',
                image_names TEXT NOT NULL DEFAULT '[]');",
        )
        .unwrap();
        let store = SqliteStore {
            conn: Mutex::new(conn),
        };
        let mut older = sample(vec![]);
        older.id = "old".into();
        older.created_at = 100;
        let mut newer = sample(vec![]);
        newer.id = "new".into();
        newer.created_at = 200;
        store.add(&older).unwrap();
        store.add(&newer).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list[0].id, "new");
        assert_eq!(list[1].id, "old");
    }
}
