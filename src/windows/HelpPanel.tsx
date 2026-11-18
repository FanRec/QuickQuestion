import "./HelpPanel.css";

export function HelpPanel() {
  return (
    <div className="help-panel">
      <h2 className="panel-heading">帮助</h2>

      <section className="help-section">
        <h3 className="help-title">两种用法</h3>
        <ul className="help-list">
          <li><strong>悬浮球（快问快答）</strong>：点大球展开输入条，回车发送，答案在上方气泡里流式显示。默认接续网页当前会话。</li>
          <li><strong>主窗口（管理历史）</strong>：从气泡点「打开」或托盘「打开主窗口」进入。左侧会话可展开看每条问题，右侧只显示选中那条。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">悬浮球</h3>
        <ul className="help-list">
          <li><strong>大球</strong>：展开/收起输入条。<strong>小球</strong>：展开/收起历史列表。</li>
          <li>整块（球、输入条、气泡）都能拖动，整体移动。</li>
          <li>历史条目右侧三个按钮：展开到主窗口 / 复制 / 删除。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">新会话与接续</h3>
        <ul className="help-list">
          <li>输入条里的 <strong>＋ 新会话</strong> 点亮后，这一次提问会开一个全新会话，发送后自动熄灭。</li>
          <li>不点亮则接续当前会话：主窗口接续你选中的那条，悬浮球接续网页当前所在的那条。</li>
          <li>会话在网页端和本机一一对应，重启后仍可接着聊。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">输入与图片</h3>
        <ul className="help-list">
          <li><kbd>Enter</kbd> 发送，<kbd>Shift+Enter</kbd> 换行，输入框自动增高。</li>
          <li>图片直接 <kbd>Ctrl+V</kbd> 粘贴，输入框上方出现缩略图；悬停预览，点 × 移除。</li>
          <li>回复期间不能再提交，右侧红色方块可打断本机接收（网页可能仍在生成）。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">复制与删除</h3>
        <ul className="help-list">
          <li>主窗口右上角、悬浮气泡、历史列表都有复制；复制的是<strong>渲染后的富文本</strong>，Snipaste 可直接贴成图。</li>
          <li>删除单条：在侧边栏的问题上右键 →「删除这条」；删除整个会话：在会话标题上右键。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">快捷键</h3>
        <ul className="help-list">
          <li><kbd>Alt+Q</kbd> 随时唤起悬浮输入条并聚焦。</li>
          <li><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>Esc</kbd> 收起悬浮面板（回复中则打断）。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">关于与声明</h3>
        <p className="help-text">
          QuickQuestion 通过浏览器调试协议（CDP）驱动网页版 DeepSeek，无需 API Key，
          但需要你先在浏览器中登录一次。该方式可能不符合服务条款，高频使用有触发账号风控的风险，请自行斟酌。
          所有问答仅保存在本机，不会上传。
        </p>
      </section>
    </div>
  );
}
