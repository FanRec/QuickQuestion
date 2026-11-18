import { useCallback, useEffect } from "react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { Composer } from "../components/Composer";
import { onHotkeyInput } from "../lib/events";
import { isSending } from "../lib/api";
import { placeComposer, resizeComposerKeepingBottom, PANEL_W } from "../lib/windows";
import "./ComposerWindow.css";

/**
 * Alt+Q 唤起的独立输入条：和悬浮球里那套外观一致，但它是另一份实例，
 * 可单独拖动、单独定位，与球互不干扰。
 */
export function ComposerWindow() {
  // 多留 8px：聚焦描边是 box-shadow（向外扩 3px 但不占布局），
  // 窗口高度若恰好等于内容高度，描边与圆角抗锯齿会被窗口边缘切掉。
  // 窗口本身透明，多出的像素不可见。
  const applyHeight = useCallback((contentHeight: number) => {
    void resizeComposerKeepingBottom(contentHeight + 8, PANEL_W);
  }, []);

  // 必须稳定引用：Composer 的自动收起计时器把它放进依赖，
  // 每次渲染新建函数会不断重置计时器，导致永不收起。
  const close = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  // 每次唤起都重新摆到当前光标处。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onHotkeyInput(() => {
      void (async () => {
        // 正在回复中就不抢：让当前那套继续把结果收完。
        const busy = await isSending().catch(() => false);
        if (busy) return;
        const win = getCurrentWindow();
        const cursor = await cursorPosition().catch(() => null);
        await placeComposer(cursor ?? { x: 400, y: 300 }, 60, PANEL_W);
        await win.show();
        await win.setFocus();
      })();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="composer-window-root" onContextMenu={(e) => e.preventDefault()}>
      <Composer variant="window" onContentHeight={applyHeight} onClose={close} />
    </div>
  );
}
