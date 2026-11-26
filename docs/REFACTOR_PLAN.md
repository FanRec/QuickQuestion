# QuickQuestion 系统性修复 / 重构 / 清理方案

> 目标：从第一性原理出发，建立一组正交机制，让当前审查发现的各类问题按类消失，
> 而不是逐条打补丁。方案要求闭环自洽：每个问题有归属，每个机制有验收，每批可独立回滚。

## 0. 方法论与第一性推导

### 0.1 本质（唯一的公理）

QuickQuestion 是**驾驶 DeepSeek 网页的快捷入口**。它不生产智能。它只做三件事：

1. 把网页会话映射为本地可管理的会话（**投影**）；
2. 把"提问 → 回复"的交互压缩到最短（**流水线**）；
3. 保存问答历史（**持久化**）。

项目此前所有"不对"的体感，根源都是把"投影"误当成"真相"，或让流水线的中间态暴露给了用户。

### 0.2 由本质推出的四条不变量

| 编号 | 不变量 | 违反现状（证据） |
|---|---|---|
| **I1 单一真相源** | 网页 `chat_id` 是会话身份的唯一权威；本地 session 只是它的持久投影 | 五个会话指针并存（currentId/selectedId/activeId/网页URL/lastSessionId）；lastSessionId 前后端双写；chat_id 绑定靠 done 时刻碰运气抓 URL（`commands:222-226`） |
| **I2 全有或全无** | 一轮问答要么完整落库+绑定+广播，要么完全不发生 | 失败留空会话（`commands:256-268`）；落库失败仍广播 done（`:205-252`）；add 无事务无外键（`store:209-235`）；空回复空转到超时（`cdp:804-806`） |
| **I3 资源有主有终** | 每个资源（进程/连接/pending/订阅者/timer/锁）有唯一所有者与释放路径 | 托盘 `try_state::<AppState>()` 类型错致进程不回收（`lib:169`）；pending 表泄漏（`cdp:372-395`）；timer 不清（`Composer:222-233`）；锁无兜底（`commands:189-273`） |
| **I4 配置不丢、错误不藏** | 写操作只改指定字段；错误必须结构化显式传播 | 缺字段全量重置（`config:9-10`）；设置覆盖恢复点（`SettingsPanel:62`）；read_reply 静默 180s（`cdp:773-776`） |

### 0.3 UNIX 设计哲学的映射

- **机制与策略分离**：后端提供机制（事务、生命周期、错误分类），前端只提供策略（显示、交互）。当前 `injectPrompt` 由前端猜、后端决策，是典型的策略越界 → 收归后端。
- **Do one thing well**：`cdp` 只管网页、`store` 只管持久化、`commands` 只管编排。当前 `commands` 兼任配置写入、会话决策、事件广播、生命周期，职责过多 → 按四机制重新收口。
- **管道组合**：`qq://` 事件总线是唯一的模块间管道。溜走的 listener、过期快照都是"管道泄漏"。
- **错误显式**：UNIX 要求程序出错写 stderr 并返回非零；本项目对应的是 `error.kind` + emit error 事件。`catch(()=>{})` 和 `Err(_)=>continue` 是对这条哲学的直接违反。
- **小即是美**：不引入状态管理库、命令模式、新框架；用 Rust 的 `Drop`、现有 Tauri 事件、现有 React state 即可。

### 0.4 为什么是这四个机制（而非逐条补丁）

四条不变量彼此正交，恰好覆盖四类问题：
- I1 管**状态语义**（谁是对的）→ M1 会话投影模型
- I2 管**操作原子性**（怎么算完成）→ M2 事务化编排
- I3 管**资源边界**（谁释放）→ M3 生命周期守护
- I4 管**配置与错误**（怎么不丢、怎么报）→ M4 字段级仓储 + 错误分类

逐条补丁会留下"修了 A 引出 B"的循环（历史上已多次发生：修接续引出高度、修裁剪引出竞态）。按机制重构则一次性消除整类问题的生存土壤。

---

## 1. 问题全景与归属（闭环对照表）

审查发现的所有问题归到四个机制；无归属的列入"清理"或"明确不做"。

| 问题 | 归属 | 问题 | 归属 |
|---|---|---|---|
| A1 真相源分裂 / D5 chat_id 未切稳 | M1 | B1 托盘类型错 / A2 生命周期 | M3 |
| E3 injectPrompt 不一致 | M1 | C5 启动超时遗留进程 | M3 |
| F1 设置覆盖恢复点 / D3 快照覆盖 | M1+M4 | C1 pending 泄漏 / C3 误关标签 | M3 |
| 冷启动不接续（首轮根因） | M1 | C4 Enter 错位 / M9 上传残留 | M3 |
| D1 回复失败留空会话 | M2 | E1 旧 timer 清回答 / E2 hideSecs 误清 | M3 |
| D2 落库失败仍广播 done | M2 | E4 监听清理竞态 / F2 窗口顺序 | M3 |
| B3 add 无事务 / 孤儿 exchange | M2 | B2 缺字段全量重置 / L3 快捷键禁用 | M4 |
| C2 空回复超时 | M2 | C8 connect 超时返 Ok / C9 静默吞错 | M4 |
| D4 发送锁无兜底 | M2 | M7 开关精确匹配 / M5 登录误分类 | M4 |
| — | — | M8 binding 死代码 / 文档漂移 / 测试缺口 | 清理 |

---

## 2. 四个机制的具体设计

### M1 会话投影模型（对应 I1）

**目标**：确立"网页 chat_id 权威 + 本地 session 投影"，前端不再持有真相。

**改动清单**：
1. `commands/mod.rs:222-226`：绑定 chat_id 不再只靠 done 时刻读 URL。接续会话时沿用 `chosen.deepseek_chat_id`；新建会话时轮询 URL 直到出现 `/a/chat/s/{uuid}`（带 5s 上限），超时则明确报错而非静默不绑定。
2. `commands/mod.rs`：新增 `resume_session` 语义——`active_session` 在网页 URL 无 chat_id 时回退读取 `last_session_id`，修冷启动不接续。
3. `commands/mod.rs:130-139`：`injectPrompt` 判定后移到后端——后端依据"chosen 会话是否已有 exchange"决定注入，前端该字段降级为无害提示（保留 IPC 兼容）。修 E3。
4. `lastSessionId` **单一写权**：只在后端成功发送后写（`remember_session`/`send_inner` 内部调用同一函数）；`update_settings` 显式忽略该字段。修 F1、D3。
5. 前端三指针职责固定：`currentId` = 用户意图焦点；`selectedId` = 右栏详情（由 currentId 派生该会话最后一条，已有 `focusSession`）；`activeId` = 网页当前位置（只读后端事件，不参与发送决策）。

**验收**：切会话 → 右栏同步（已修）；冷启动悬浮接续显示"接续：xxx"（已修显示层 + 本机制补数据源）；设置页保存不再冲掉恢复点；重复提问注入行为与首轮一致。

### M2 事务化编排（对应 I2）

**目标**：一轮问答是一个原子操作，有明确的状态机与统一的失败收口。

**改动清单**：
1. **SendGuard（RAII）**：`try_begin_send()` 返回守卫，其 `Drop` 调用 `end_send()`。删除所有手动 `end_send()`（`commands:85,261`）。任何路径退出——包括 panic 前——锁必释放。修 D4。
2. **统一失败收口**：把 D1 的回滚从"仅 sent 阶段"扩展到整个轮次。Error 分支（`:256-268`）检查 `new_session_id` 对应会话是否已有 exchange，无则删会话、恢复 lastSessionId 旧值。
3. **落库与绑定同事务**：`store.add` 与 `bind_chat_id` 包进一个事务；`add()` 失败则 emit error + unsubscribe + break，**绝不发 done**。修 D2、B3。
4. **空回复完成**：`cdp:804` 的 `if text.is_empty(){continue}` 改为——`generating=false` 时即使文本为空也发 `Done{text:""}`，避免空转 180s。修 C2。
5. **schema 外键**：`sessions`/`exchanges` 加 `FOREIGN KEY(session_id) ... ON DELETE CASCADE` + `PRAGMA foreign_keys=ON`（迁移需兼容旧库）。修 B3 孤儿。

**验收**：新增/补单测——发送失败后无空会话、add 失败只发 error、空文本能 Done、发送锁异常释放；真机：回复中途关应用重启，无孤儿记录。

### M3 生命周期守护（对应 I3）

**目标**：每个资源有唯一所有者，所有退出路径统一收口。

**改动清单**：
1. `lib.rs:169` 改 `try_state::<Arc<AppState>>()`；加 `RunEvent::Exit`/`on_exit` 钩子统一 `shutdown()`，`BrowserManager` 实现 `Drop` 双保险。修 B1、A2。
2. `browser/mod.rs:69-84`：启动 30s 超时分支先 `kill()+wait()` 子进程再返回错误。修 C5。
3. `cdp/mod.rs:372-395`：`call()` 用 RAII 清理 pending——发送失败或 timeout 时 remove 对应 id。修 C1。
4. `cdp/mod.rs:834-856`：`find_page_socket` **不再主动关闭用户标签**；只选择最新 DeepSeek 标签（不改动其他），并在选择日志中记录。修 C3。`port_ready` 增加身份校验（本 profile 的 Browser 标识）。
5. `cdp/mod.rs:719-732` 与 `:232-239`：抽取统一的"查找可见输入框"JS，写入与派发 Enter 共用同一元素引用（挂 `window.__qqInput`）。修 C4。
6. 前端：`Composer.submit()` 开头清理 `hideTimer`（修 E1）；`hideSecs` 用 ref 传递使 effect 不依赖它（修 E2）；所有 `listen()` 用 `AbortController` 的 `signal` 或在 cleanup 设 disposed 标志（修 E4）；`showWindow` 改 `unminimize → show → setFocus`（修 F2）。
7. `tauri.conf.json` 三窗口统一在前端注册 `onCloseRequested → hide`（修 A2 的 Alt+F4 销毁）。

**验收**：托盘退出后 `tasklist` 无残留浏览器；30s 超时无孤儿；连发两条不被旧 timer 清空；多标签场景用户标签不被关；Alt+F4 后悬浮球可恢复。

### M4 字段级仓储 + 错误分类（对应 I4）

**目标**：配置写是 merge，错误是结构化数据而非静默。

**改动清单**：
1. `config.rs:9-10` 为 `browser_port`/`quiet_ms` 补 `#[serde(default)]`（或结构体级 `#[serde(default)]`）；`load()` 区分"文件不存在"与"解析失败"，后者保留上次已知配置或至少不立即回写。修 B2。
2. `update_settings` 只覆盖白名单字段（browserPort/quietMs/systemPrompt/hotkey/bubbleHideSecs/popupHideSecs），`lastSessionId` 保留后端值——与 M1.4 双保险。
3. `cdp/mod.rs:773-776`：连续 N 次（如 5 次）`read_reply()` 失败即 emit `Error`（带原始错误文本 + kind），不再静默 continue 180s。修 C9。
4. `cdp/mod.rs:357-365`：`connect()` 等待输入框超时返回 `Err` 而非 `Ok`，`ensure_cdp` 不缓存坏连接。修 C8。
5. `cdp/mod.rs:604-645`：`apply_modes` 文案改为包含匹配（`indexOf(label)>=0`）或基于 `aria-label`，修 M7；登录态判定失败分类为"检测失败"而非"页面结构变化"，修 M5。

**验收**：残缺 settings.json 不重置其他配置；设置页与悬浮球并发改 lastSessionId 不互相覆盖；页面改版时收到明确错误事件而非超时。

---

## 3. 分批落地计划

每批独立可验证、可提交、可回滚。批 0 风险最低先止血；批 2/3 涉及语义，放后面。

| 批次 | 范围 | 主要文件 | 门禁 | 回滚 |
|---|---|---|---|---|
| **批 0 止血** | B1, B2, C1, C2, E1, F1（已验证铁证） | lib.rs, config.rs, cdp/mod.rs, Composer.tsx, SettingsPanel.tsx | tsc + cargo check/test + vite build | 单 commit revert |
| **批 1 资源边界** | M3 剩余（A2, C3, C4, C5, 窗口/timer/listen） | browser, cdp, windows.ts, 三窗口, tauri.conf | 同上 + 真机：多标签/托盘退出/Alt+F4 | 单 commit revert |
| **批 2 编排事务化** | M2 全部 | commands/mod.rs, store/mod.rs, lib.rs | 同上 + 新增 3 个单测 | 单 commit revert |
| **批 3 真相源归一** | M1 全部（含首轮遗留的恢复与注入） | commands/mod.rs, Composer.tsx, MainWindow.tsx, api.ts | 同上 + 真机点验清单 | 单 commit revert |
| **批 4 清理与补强** | M4 剩余 + 死代码 + 文档对齐 + 测试 | cdp, config, ARCHITECTURE.md, tests | 同上 | 单 commit revert |

**真机点验清单**（批 1/3 后）：托盘退出无残留进程；多标签不被关；连续两条提问不被清空；冷启动接续显示正确；重复提问注入一致；落库失败不发 done。

---

## 4. 闭环自洽性论证

1. **正交性**：M1 定义状态语义、M2 保证原子性、M3 保证资源边界、M4 保证配置与错误。四者无功能重叠——例如 lastSessionId 的写权只在 M1（语义）和 M4（merge）各出现一次，且方向一致。
2. **完整性**：第 1 节对照表覆盖审查全部发现；未归属项进入"清理"或"明确不做"两节，无遗漏。
3. **与既有修复兼容**：本轮已提交的接续显示三态、未提交的 focusSession 均落在 M1 的"前端三指针职责固定"内，是机制的一部分而非推翻重来。
4. **验证策略**：每批有编译门禁；涉及语义的批次有针对性单测；涉及用户可感知行为的批次有真机点验清单。
5. **风险与回滚**：每批单 commit，问题可单批 revert，不牵连其他批次。批 2/3 风险最高，安排在批 0/1 验证机制稳定后。

---

## 5. 明确不做的事（克制，不过度工程）

- 不引入状态管理库、命令模式、新框架、tracing/metrics；用现有 Rust `Drop` + Tauri 事件 + React state 足够。
- 不重写 CDP 的 DOM 探测策略（C6/C7 页面改版类）：网页版脆弱是本项目**本质约束**，接受它，靠"错误显式化"而非层层防御来应对。
- 不改任何 UI 视觉与交互稿。
- 不自动清洗历史脏数据（沿用既有决策）。
- 不为"推测的失败模式"写代码——本方案每一项都对应已复核的源码证据。

---

## 6. 决策记录（已裁决并实施）

裁决判据：**只为"正确且存在"的东西兼容**——数据格式（旧 settings.json、旧 SQLite 缺列）正确且存在，保留兼容；错误行为（前端猜注入、擅自关标签）不兼容；不存在的场景（IPC 版本错配，Tauri 前后端同包发布）兼容是幻觉。

1. **injectPrompt 后移 + 冷启动恢复**：已实施（批 3）。删除 IPC 字段，后端以 `new_session_id.is_some()` 判定首条；`active_session` 在网页无 chat_id 时回退 `last_session_id`。
2. **多标签行为**：已实施（批 1）。不关闭用户标签；用 `REMEMBERED_TARGET` 记住选中 target 供重连复用——把"靠删除保证确定性"换成"靠所有权保证确定性"。
3. **外键迁移**：放弃。SQLite 加外键需重建表，风险高收益低；孤儿的根因已由 M2 的事务与 `rows_affected` 检查从源头杜绝。替代方案已实施：`commit_exchange` 检查 UPDATE 影响行数，会话不存在则整轮回滚。

## 7. 实施状态

全部批次完成并提交（批 0 `dfa85af`、批 1 `5252fc7`+`7175694`、批 2 `b7f14b4`、批 3 `5dfda3e`、批 4 见最新提交）。
门禁：tsc ✅ / cargo check --tests ✅ / cargo test --lib **31 passed** ✅ / cargo clippy --all-targets 无代码告警 ✅ / vite build ✅。
真机未验证项（本环境无登录态浏览器）：浏览器进程回收、多标签不误关、冷启动接续显示、注入首条、发送失败回滚、chat_id 补绑。

## 8. 已知未处理（待决策）

写在这里而不是散在代码注释里，避免下一轮审查重复推导。

**2026-11-26 补充轮**：修复四项——
1. 新建会话 chat_id 超时静默不绑定：改为"先落库交付、后台有界补绑"。
   原先 done 时刻 5s 抓不到 URL 就永不绑定，该会话永久无法接续。
   补绑写入前校验 chat_id 未被其他本地会话占用，防止用户期间切会话导致串绑。
   这不是"推测的失败模式"：SPA 导航晚于回复完成是实证过的时序，且
   §M1.1 早已承诺"不许静默不绑定"，原实现只落了"不报错"，没落"不静默"。
2. 托盘唤起窗口未 unminimize：Rust 侧三处入口收口为 `restore_window`，
   与前端 `showWindow` 同语义。主窗口最小化后托盘无法还原是可复现 bug。
3. 悬浮球连续复制的提示 timer 竞态：改用单一 ref timer 收口。
   另清理两处无风险冗余（Enter 脚本 raw string 内多余的 `{{`/`}}`、
   clippy 的两条风格告警）。
4. 托盘「显示悬浮球」改为真切换；悬浮球右键新增「隐藏悬浮球」。
   可见性由 `tray.rs` 单点收口，窗口状态、托盘文案与前端临时 UI 一起更新；
   同时修掉打断最长等 3s 才释放发送权、粘贴图片永不清理、CDP 通配跨域开放、
   设置 RMW 无锁、历史菜单贴底裁切、几何回显误判拖动等问题。

下列 5 项经复核仍决定不处理，理由见各条（原第 6 项设置写锁已在本轮实施）；
其中前端测试网（第 2 项）是抽取流式公共 hook 的前置条件，保留记录供未来开发者评估，
不因"看起来该做"而提前引入。

1. **长问题的展示标题**（2026-11-25 定位，未实施）：`question_text` 同时充当发给 DeepSeek 的完整载荷与复制/贴图的标题，
   长问题会让 `to_markdown` 把全文塞进剪贴板、`render-image` 超过 8000px 直接报「内容过长」。
   推荐方向是输出侧单一派生 `questionHeadline()`（首个非空行 / 前 N 字 / 去 markdown 前缀），输入侧附件化后置；零 schema 变更。
2. **前端无测试网**：`src/` 只有类型检查，没有运行时测试。以下重构因此被主动推迟——抽公共的流式管道 hook、
   拆 `MainWindow` 的侧栏/详情/输入区——它们都压在核心发送路径上，没有等价性证据就动，风险大于去重收益。
   前置条件：先引入 vitest，为 `is_complete`、接续派生这类纯函数建立回归网。
3. **跨文件 CSS 依赖**：主窗口输入区的图片缩略图复用 `Composer.css` 的 `.composer-image-*`，靠单包全量 CSS 生效。
   功能正常但耦合隐式；真要收口应把缩略图抽成组件，而不是复制样式。
4. **页面脚本（`cdp/mod.rs` 内的 JS 字符串）没有回归网**：读回复的身份识别逻辑只能靠真机验证，
   或临时用 DOM 桩重放时序（一次性脚本，未入库）。2026-11-26 加固后判定顺序为：发送前属性标记 →
   发送前条数 `prevCount`（标记丢失时按位置认新）→ 文本快照。文本锚点失配时再按"新增且不同于
   `prevAnswer`"的助手节点兜底，避免长问题被页面折叠后永远 `found=false`。
   仍未解决：页面脚本无自动化回归网；若后续要给这块上测试，第一步是把这两段脚本从 Rust 字符串
   挪到 `include_str!` 的 .js 文件，再挂 node 测试。
5. **会话切换与发送的并发**（2026-11-25 审查，未改）：`switch_session` 只读 `sending` 标志、不占位，
   而 `send_inner` 在准备期会自己导航。两者并发时是两次 `Page.navigate` 竞争，SPA 最终停在哪个会话不确定；
   最坏结果是本轮锚点永远读不到 → 180s 超时（**不会写错数据**，失败路径不落库）。
   最直接的修法是让切换也持有发送权，但导航最长 20s，`is_sending` 会被污染成"正在回复中"，
   悬浮球让位、Alt+Q 拒开都会误判。要修得给网页操作单独一把锁，收益不抵复杂度，暂记。
6. **设置是"读-改-写"且无锁**：已实施。`ConfigService` 内部持有跨 clone 共享的写锁，
   `set_last_session`、`restore_last_session_if`、`save` 的整段 RMW 都在锁内；`load()` 无锁，
   靠"临时文件 + 改名"的原子替换读到旧值或新值，不会读到半截 JSON。写锁只串行写操作，
   不阻塞读，也不存在嵌套加锁（`save_inner` 仅供已持锁的方法调用）。
