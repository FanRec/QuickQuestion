# M4 详细设计 — 历史持久化与三视图联动

## 目标
把 M3 的内存占位仓储替换为 SQLite 持久化，让悬浮列表、主窗口左栏、主窗口详情三处读**同一份真实数据**，并实现「复制问题与回复」格式。

## 数据模型（对齐 ARCHITECTURE.md §2）
```sql
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  answer_text TEXT NOT NULL DEFAULT '',
  image_names TEXT NOT NULL DEFAULT '[]'  -- JSON 数组
);
CREATE INDEX IF NOT EXISTS idx_exchanges_created ON exchanges(created_at DESC);
```

## store 模块重构
`src-tauri/src/store/mod.rs`：
- `SqliteStore { conn: Mutex<Connection> }`（rusqlite，单连接 + Mutex 串行化，足够桌面单用户）。
- 数据库路径：`%APPDATA%/QuickQuestion/exchanges.db`（用 dirs::data_dir）。
- 方法：`init()` 建表、`add(Exchange)`、`list() -> Vec<Exchange>`（倒序）、`get(id) -> Option<Exchange>`、`delete(id)`。
- `AppState.store` 类型从 `MemoryStore` 换成 `SqliteStore`；命令层签名不变（M3 已按此设计）。

## IPC 命令
- `list_exchanges() -> Vec<Exchange>`：悬浮列表与主窗口左栏共用。
- `get_exchange(id) -> Option<Exchange>`：主窗口详情。
- `delete_exchange(id)`：可选删除（列表右键或按钮，M4 做最小实现）。
- `copy_markdown(id) -> String`：生成 `## {question}\n{answer}`，图片占位符追加到问题末尾（图片是独立附件，不在文字中，无法定位到中间）。
  **剪贴板写入放在前端**（`@tauri-apps/plugin-clipboard-manager`），Rust 只负责生成文本——便于纯函数测试格式。
- `send_message` 完成时改为写入 SQLite（M3 已写内存仓储，M4 换实现）。

## 复制格式规范（已锁定）
```
## 问题文本
回复文本
```
- 问题前加 `## `（Markdown 二级标题）。
- 问题与回复之间一个换行。
- 图片以 `[图片1]`、`[图片2]` 占位（image_names 顺序）。
- 前端点击复制按钮 → invoke `copy_markdown(id)` → Rust 生成文本 + 写剪贴板 → 前端显示"已复制"轻提示。

## 前端改动
- `lib/mockData.ts` 删除，改用 `lib/api.ts` 封装 IPC 命令（typed）。
- `HistoryWindow.tsx`：挂载时 `list_exchanges()` 加载真实列表；两个按钮分别接 `showWindow("main") + 选中` 与 `copy_markdown`。
- `MainWindow.tsx`：挂载时加载列表，选中态调用 `get_exchange` 显示详情。
- 窗口间选中联动：历史列表点「展开」→ 通过 Tauri event `qq://select` 通知主窗口选中某 id；主窗口监听并加载。
- 流式 done 事件后，两个列表窗口收到 `qq://refresh` 事件重新拉取列表。

## 依赖新增
- `rusqlite = { version = "0.37", features = ["bundled"] }`（bundled 避免系统 SQLite 依赖）
- `tauri-plugin-clipboard-manager`（写剪贴板）

## 验收清单
1. `cargo check` + `npm run build` 通过。
2. 集成测试：SQLite 建表 → add → list 倒序 → get → delete 正确（普通 `#[test]`，无需浏览器）。
3. 前端流程：发消息 → 落库 → 历史列表出现 → 主窗口可见 → 复制格式正确。
4. 代码审查与重构后 git commit。

## 实现期修正（源码实证）
1. **图片占位符位置**：初版用 `replacen(文件名, ...)` 替换，但图片是独立附件、问题文字中不含文件名，永不命中。
   改为按顺序把 `[图片1] [图片2]` **追加到问题文本末尾**。单元测试覆盖。
2. **剪贴板在前端写**：Rust 的 `copy_markdown` 只返回格式化字符串，前端用 clipboard-manager 插件写入，格式便于纯函数测试。
3. **三视图联动**：历史列表点展开 → emit `qq://select{id}` → 主窗口 `onSelect` 加载详情；
   问答 done → chat 窗口 emit `qq://refresh` → 历史列表重载。

## 已知遗留（登记到 M6）
- 主窗口不监听 `qq://refresh`，打开期间新问答不会自动进入其左栏（需重新打开）。M6 补。
- 无删除交互入口（`delete_exchange` 命令已备但未接 UI）。登记 M5/M6。

## 审查关注点
- 三视图是否真的单一数据源（都走 IPC，不缓存副本）。
- 事件刷新是否覆盖"另一窗口正在打开"的场景。
- 复制格式边界：问题含换行、图片占位顺序。
- SQLite 迁移兼容（首次建表幂等）。
