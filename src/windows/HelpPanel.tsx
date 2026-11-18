import "./HelpPanel.css";

export function HelpPanel() {
  return (
    <div className="help-panel">
      <h2 className="panel-heading">帮助</h2>

      <section className="help-section">
        <h3 className="help-title">快速开始</h3>
        <ul className="help-list">
          <li>点击桌面上的<strong>大悬浮球</strong>打开聊天输入框，输入问题后回车发送。</li>
          <li>输入图片可随问题一起发送；答案会以流式气泡显示在输入框上方。</li>
          <li>点击<strong>小悬浮球</strong>查看全部历史问答。</li>
          <li>历史条目右侧：第一个按钮展开完整详情，第二个按钮复制「问题与回复」。</li>
        </ul>
      </section>

      <section className="help-section">
        <h3 className="help-title">复制格式</h3>
        <p className="help-text">
          复制内容会自动把问题设为 Markdown 二级标题，并在问题与回复之间换行：
        </p>
        <pre className="help-code">## 你的问题
回复内容</pre>
      </section>

      <section className="help-section">
        <h3 className="help-title">快捷键</h3>
        <ul className="help-list">
          <li><kbd>Esc</kbd> 关闭聊天栏或悬浮列表（生成中关闭会停止本机接收）</li>
          <li><kbd>Enter</kbd> 发送问题</li>
        </ul>
        <p className="help-text">
          说明：取消只能停止本机接收流式内容，DeepSeek 网页可能仍在生成剩余回复。
        </p>
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
