use std::sync::Mutex;

use crate::model::Exchange;

/// M3 阶段的内存占位仓储。M4 将替换为 SQLite 实现，命令层签名保持不变。
pub struct MemoryStore {
    items: Mutex<Vec<Exchange>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(Vec::new()),
        }
    }

    pub fn add(&self, exchange: Exchange) {
        self.items.lock().unwrap().push(exchange);
    }

    pub fn list(&self) -> Vec<Exchange> {
        self.items.lock().unwrap().clone()
    }
}
