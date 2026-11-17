# M0 详细设计 — 项目骨架与苹果风格设计系统

## 目标
验证技术栈可运行、设计系统可落地。**不接 DeepSeek、不建表、不做交互逻辑。**

## 目录结构
```
QuickQuestion/
├─ docs/                        # 设计文档（本目录）
├─ src/                         # 前端
│  ├─ main.tsx                  # 按 ?window= 路由到四个窗口入口
│  ├─ windows/
│  │  ├─ OrbWindow.tsx          # M0 只实现此窗口的视觉
│  │  ├─ ChatWindow.tsx         # M1 填充
│  │  ├─ HistoryWindow.tsx      # M1 填充
│  │  └─ MainWindow.tsx         # M1 填充
│  ├─ styles/
│  │  ├─ tokens.css             # 苹果风格变量（明暗双主题）
│  │  └─ global.css             # 重置 + 基础
│  └─ vite-env.d.ts
├─ src-tauri/                   # Rust 内核
│  ├─ Cargo.toml
│  ├─ tauri.conf.json           # 四窗口声明
│  ├─ build.rs
│  ├─ capabilities/default.json
│  ├─ icons/                    # tauri icon 生成
│  └─ src/
│     ├─ main.rs                # 入口
│     ├─ lib.rs                 # run() + 模块注册（占位命令）
│     └─ commands/mod.rs        # 占位 ping 命令
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
└─ .gitignore
```

> 注：`model/` `cdp/` `browser/` `store/` 不在 M0 创建——空占位模块无价值，
> 按最小依赖原则在各自里程碑（M2/M4）随实现一并引入。

## 依赖清单（M0 最小集）
- 前端：`react@19`、`react-dom@19`、`typescript`、`vite`、`@vitejs/plugin-react`、`@tauri-apps/api`
- 后端：`tauri@2`、`serde`、`serde_json`
- 工具：`@tauri-apps/cli@2.12.5`
- 延后引入：rusqlite / tokio-tungstenite / clipboard 插件 / markdown-it（各自里程碑再装）

## 四窗口声明（tauri.conf.json）
| label | 尺寸 | 属性 | M0 显隐 |
|---|---|---|---|
| orb | 132×56 | transparent, decorations:false, alwaysOnTop, skipTaskbar, resizable:false, shadow:false | visible |
| chat | 420×240 | transparent, decorations:false, alwaysOnTop, skipTaskbar, resizable:false, shadow:false | hidden |
| history | 340×480 | transparent, decorations:false, alwaysOnTop, skipTaskbar, shadow:false | hidden |
| main | 1080×680 | 普通标题栏，center | hidden |

所有窗口 URL 为 `index.html?window=<label>`，前端 `main.tsx` 读取查询参数决定渲染哪个入口。

## 苹果风格设计系统落地
- `tokens.css` 定义 `:root` 与 `@media (prefers-color-scheme: dark)` 两套变量，值与 ARCHITECTURE.md §6 一致。
- Orb 窗口 M0 视觉：主球 44px 圆形，轻微毛玻璃 + 内阴影 + 高光小球；左侧 26px 次级球；两者间距 10px；整体水平居中。球内用简单符号（主球 ✦ 风格化 SVG，小球时钟/列表 SVG），不用 emoji。
- 全站禁用系统默认 focus 蓝框，改用 `--accent` 柔和 ring。

## 验收清单
1. `npm install` 成功
2. `npm run tauri dev` 编译 Rust 成功、启动应用
3. orb 窗口显示苹果风格主球 + 小球，透明背景正确
4. 浏览器控制台无错误
5. `cargo check` 通过
6. 代码审查：无未用变量、无硬编码重复、注释说明依赖假设
7. `git add` + `git commit -m "chore: bootstrap Tauri 2 project with Apple-style design tokens"`

## 审查关注点
- tauri.conf.json 的窗口属性是否被平台正确应用（尤其 transparent + shadow:false）
- 前端路由是否对未来三个窗口留出干净的扩展点（不得把四窗口逻辑写死在一个组件）
- tokens 语义化命名，不得在组件里散写颜色值
