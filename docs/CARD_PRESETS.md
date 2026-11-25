# 贴图样式预设

「贴图」把问答渲染成 PNG。样式可以被替换：内置两款（经典、朴素）之外，可以在本地目录里放入自己写的预设，在设置页「贴图样式」中选中。

## 目录

预设目录是 `%LOCALAPPDATA%\QuickQuestion\card-presets\`。在设置页点行尾的文件夹图标可直接打开（目录不存在会自动创建）。每个子目录即一个预设：

```
card-presets/
└── my-style/
    ├── preset.json      可选：{"label":"我的样式","description":"说明"}
    ├── tokens.css       必需：CSS 变量覆盖
    ├── background.png   可选：卡片外框背景图
    ├── top.svg          可选：右上角装饰
    ├── bottom.svg       可选：底部波浪装饰
    └── mascot.png       可选：右下角吉祥物
```

目录名即预设 id，只允许 ASCII 字母、数字、连字符、下划线（最长 64 字符）。`classic` 与 `plain` 是内置保留 id，同名目录会被忽略。

## tokens.css

固定骨架由应用提供，预设只写变量覆盖。最小可用示例：

```css
.qq-frame {
  --qq-frame-bg: #f4f4f5;
  --qq-card-bg: #fff;
  --qq-frame-pad: 16px;
  --qq-frame-radius: 8px;
  --qq-card-radius: 8px;
  --qq-shadow: none;
  --qq-title: #27272a;
  --qq-body: #3f3f46;
}
.qq-frame[data-qq-theme="dark"] {
  --qq-frame-bg: #18181b;
  --qq-card-bg: #1f1f23;
  --qq-title: #f4f4f5;
  --qq-body: #e4e4e7;
}
.qq-decor-top, .qq-decor-bottom, .qq-mascot { display: none; }
.qq-title::before { display: none; }
```

可覆盖的变量：

| 变量 | 含义 |
|---|---|
| `--qq-frame-bg` / `--qq-card-bg` | 外框 / 卡片背景，`background` 简写可用渐变或图片 |
| `--qq-frame-pad` / `--qq-frame-radius` / `--qq-card-radius` | 外边距与圆角 |
| `--qq-border` / `--qq-shadow` | 卡片描边与阴影 |
| `--qq-title` / `--qq-body` / `--qq-muted` | 标题、正文、次要文字颜色 |
| `--qq-accent` / `--qq-badge` / `--qq-rule` | 强调色、序号徽标、分隔线 |
| `--qq-code-bg` / `--qq-code-text` / `--qq-gutter` | 代码块背景、代码文字、行号 |
| `--qq-table-line` | 表格线 |
| `--qq-decor-top-image` / `--qq-decor-bottom-image` / `--qq-mascot-image` | 装饰图，通常由同名资源文件自动生成 |

变量定义在 `.qq-frame` 上即可被子元素继承；明暗两套用 `.qq-frame[data-qq-theme="dark"]` 分开写。没有写 dark 分支时，暗色主题会沿用基线中的深色经典配色。

除变量外也可以写普通 CSS 规则，例如 `display:none` 隐藏装饰、改字号、改圆角。**不要改骨架结构**（`.qq-frame`、`.qq-card`、`.qq-content` 及三个装饰容器），也不要引用外部资源。

## 资源文件

放进目录的同名文件会自动转成 data URI 并注入对应变量，无需在 CSS 里写 `url()`：

- `background.png` → `--qq-frame-bg`（`center/cover no-repeat`）
- `top.svg` → `--qq-decor-top-image`
- `bottom.svg` → `--qq-decor-bottom-image`
- `mascot.png` → `--qq-mascot-image`

原因：渲染走 SVG-as-image 隔离文档，任何 `file://` / `asset://` / 相对路径外链都不会加载。如果自己写装饰 SVG，**颜色要写成字面色值**，不要用 `var(--qq-*)`——SVG 表现属性不认 CSS 变量。

限制：`tokens.css` 不超过 64 KiB；单张资源图不超过 2 MiB。

## 生效与失败

- 增删预设后点设置页的「刷新」；无需重启应用。
- 已选中的预设被删掉时，设置页会明确提示「当前选择的样式未找到」，贴图也会报错；不会静默回退到经典。
- `tokens.css` 缺失、体积超限或资源读失败时，对应卡片显示「加载失败」并不可选，鼠标悬停可看具体原因。
- `preset.json` 损坏时以目录名作为显示名，不阻止加载。

预览卡片使用与真实贴图相同的渲染函数，因此预览就是结果；主题切换只影响预览，实际贴图跟随应用外观主题。
