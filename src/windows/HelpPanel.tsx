import { useRef, useState } from "react";
import "./HelpPanel.css";

type SectionId = "usage" | "orb" | "session" | "input" | "copy" | "keys" | "faq" | "about";

const NAV: { id: SectionId; label: string }[] = [
  { id: "usage", label: "两种用法" },
  { id: "orb", label: "悬浮球" },
  { id: "session", label: "新会话与接续" },
  { id: "input", label: "输入与图片" },
  { id: "copy", label: "复制与删除" },
  { id: "keys", label: "快捷键" },
  { id: "faq", label: "常见问题" },
  { id: "about", label: "关于" },
];

export function HelpPanel() {
  const [active, setActive] = useState<SectionId>("usage");
  const scrollRef = useRef<HTMLDivElement>(null);

  const jumpTo = (id: SectionId) => {
    setActive(id);
    scrollRef.current
      ?.querySelector(`#help-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // 滚动联动：右栏滚到哪一节，导航高亮跟到哪一节。
  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    let current: SectionId = NAV[0].id;
    for (const item of NAV) {
      const el = root.querySelector(`#help-${item.id}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= 96) current = item.id;
    }
    setActive(current);
  };

  return (
    <div className="help-panel">
      <aside className="help-nav">
        <div className="help-nav-group">使用指南</div>
        {NAV.slice(0, 6).map((item) => (
          <button
            type="button"
            key={item.id}
            className={`help-nav-item${active === item.id ? " is-active" : ""}`}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="help-nav-group">其他</div>
        {NAV.slice(6).map((item) => (
          <button
            type="button"
            key={item.id}
            className={`help-nav-item${active === item.id ? " is-active" : ""}`}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="help-main" ref={scrollRef} onScroll={onScroll}>
        <h2 className="help-heading">QuickQuestion 使用说明</h2>
        <p className="help-lead">
          通过浏览器驱动网页版 DeepSeek，把提问和复制答案的步骤压到最短。所有问答只保存在本机。
        </p>

        <section className="help-section" id="help-usage">
          <h3 className="help-title">两种用法</h3>
          <ul className="help-list">
            <li>
              <strong>悬浮球</strong>：点大球展开输入条，回车发送，答案在上方气泡里流式显示。
              默认接续网页当前会话。
            </li>
            <li>
              <strong>独立输入条</strong>：任意界面按 <kbd>Alt+Q</kbd>，在鼠标位置弹出一模一样的一条，
              可单独拖动，用完自动收起（可配置）。
            </li>
            <li>
              <strong>主窗口</strong>：从气泡点「打开」或托盘菜单进入，用来翻历史、搜问题和复制。
            </li>
          </ul>
        </section>

        <section className="help-section" id="help-orb">
          <h3 className="help-title">悬浮球</h3>
          <ul className="help-list">
            <li><strong>大球</strong>展开/收起输入条，<strong>小球</strong>展开/收起历史列表。</li>
            <li>整块都能拖动；展开时球本身的位置不会移动。</li>
            <li>历史条目右侧两个图标：直接复制整条问答，以及「更多」菜单（查看 / 复制为图片 / 删除）。</li>
          </ul>
        </section>

        <section className="help-section" id="help-session">
          <h3 className="help-title">新会话与接续</h3>
          <ul className="help-list">
            <li>
              输入条里的 <strong>＋ 新会话</strong> 点亮后，这一次提问会开一个全新会话，发送后自动熄灭。
            </li>
            <li>不点亮则接续当前会话：主窗口接续你选中的那条，悬浮球接续网页当前所在的那条。</li>
            <li>会话在网页端和本机一一对应，重启后仍可接着聊。</li>
          </ul>
        </section>

        <section className="help-section" id="help-input">
          <h3 className="help-title">输入与图片</h3>
          <ul className="help-list">
            <li><kbd>Enter</kbd> 发送，<kbd>Shift+Enter</kbd> 换行，输入框会随内容增高。</li>
            <li>图片直接 <kbd>Ctrl+V</kbd> 粘贴，输入框上方出现缩略图；悬停预览，点 × 移除。</li>
            <li>回复期间不能再提交；红色方块可打断本机接收（网页可能仍在生成剩余内容）。</li>
          </ul>
        </section>

        <section className="help-section" id="help-copy">
          <h3 className="help-title">复制与删除</h3>
          <ul className="help-list">
            <li>
              <strong>复制</strong>：得到渲染后的富文本，Snipaste 的「贴文本」可贴成图片。
            </li>
            <li>
              <strong>贴图</strong>（历史菜单里叫「复制为图片」）：把问答渲染成一张排版好的 PNG
              放进剪贴板，再用 Snipaste 贴到屏幕。样式跟随当前主题，图片不可选中文字。
            </li>
            <li>删除单条：在侧边栏的问题上右键 →「删除这条」。</li>
            <li>删除整个会话：在会话标题上右键 →「删除整个会话」。</li>
          </ul>
        </section>

        <section className="help-section" id="help-keys">
          <h3 className="help-title">快捷键</h3>
          <ul className="help-list">
            <li><kbd>Alt+Q</kbd> 随时唤起独立输入条（可在设置里修改）。</li>
            <li><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>Esc</kbd> 收起或打断。</li>
          </ul>
        </section>

        <section className="help-section" id="help-faq">
          <h3 className="help-title">常见问题</h3>
          <dl className="help-faq">
            <dt>点了发送但一直没有回答？</dt>
            <dd>多半是浏览器里未登录或触发了人机验证。提问失败时点提示里的「去登录」；也可打开主窗口 → 设置 → 打开登录窗口。</dd>
            <dt>为什么回答只显示了一部分？</dt>
            <dd>本项目通过读取网页内容获取回答，页面结构变化时可能截断。可在设置里调大「回复完成判定」的毫秒数。</dd>
            <dt>按 Alt+Q 没反应？</dt>
            <dd>快捷键可能被其他软件占用。到设置里换一个组合，修改后需要重启应用。</dd>
          </dl>
        </section>

        <section className="help-section" id="help-about">
          <h3 className="help-title">关于与声明</h3>
          <p className="help-text">
            QuickQuestion 通过浏览器调试协议（CDP）驱动网页版 DeepSeek，无需 API Key，
            但需要你先在浏览器中登录一次。该方式可能不符合服务条款，高频使用有触发账号风控的风险，
            请自行斟酌。所有问答仅保存在本机，不会上传。
          </p>
        </section>
      </div>
    </div>
  );
}
