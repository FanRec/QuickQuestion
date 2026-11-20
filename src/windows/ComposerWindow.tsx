import { useCallback, useEffect, useRef } from "react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { Composer } from "../components/Composer";
import { onHotkeyInput } from "../lib/events";
import { isSending } from "../lib/api";
import { noteWindowPosition, placeComposer, resizeComposerKeepingBottom, PANEL_W } from "../lib/windows";
import "./ComposerWindow.css";

/**
 * Alt+Q 唤起的独立输入条：和悬浮球里那套外观一致，但它是另一份实例，
 * 可单独拖动、单独定位，与球互不干扰。
 */
export function ComposerWindow() {
  // 最近一次上报的窗口高度（内容 + 16px 余量）。唤起时直接按它摆放，
  // 不再先压到占位高度——否则内容侧的 resize 会和唤起竞争：
  // resize 读到"尺寸已是目标值"提前返回，随后窗口被压矮，上半截被裁掉。
  const contentHRef = useRef(60);

  // 多留 16px：内容靠窗口底部对齐，描边外扩的 1.5px 两头都要有空间——
  // 8px 给底部（root 的 padding-bottom 垫起），8px 给顶部。
  // 窗口本身透明，多出的像素不可见。
  const applyHeight = useCallback((contentHeight: number) => {
    contentHRef.current = contentHeight + 16;
    void resizeComposerKeepingBottom(contentHeight + 16, PANEL_W);
  }, []);

  // 必须稳定引用：Composer 的自动收起计时器把它放进依赖，
  // 每次渲染新建函数会不断重置计时器，导致永不收起。
  const close = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  // 拖动绕过几何操作直接改 OS 窗口位置，onMoved 回填缓存，锚点才不会失真。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onMoved(({ payload }) => noteWindowPosition("composer", payload.x, payload.y))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Alt+F4 会销毁无边框窗口，之后 Alt+Q 拿不到实例；改为隐藏。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void getCurrentWindow().hide();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 唤起含多段 IPC await，连按 Alt+Q 会并发执行、把流式气泡来回搬位；用一个标志去重。
  const wakingRef = useRef(false);

  // 每次唤起都重新摆到当前光标处。
  useEffect(() => {
    const ac = new AbortController();
    onHotkeyInput(() => {
      if (wakingRef.current) return;
      wakingRef.current = true;
      void (async () => {
        try {
          const win = getCurrentWindow();
          const busy = await isSending().catch(() => false);
          // 正在回复时区别对待：窗口可见说明回复的就是这个窗口本身，
          // 把气泡原样带到光标处；不可见说明回复发生在球/主窗口，
          // 弹一个空输入条只会抢戏，保持不动。
          if (busy && !(await win.isVisible().catch(() => false))) return;
          const cursor = await cursorPosition().catch(() => null);
          await placeComposer(cursor ?? { x: 400, y: 300 }, contentHRef.current, PANEL_W);
          await win.show();
          await win.setFocus();
        } finally {
          wakingRef.current = false;
        }
      })();
    }, ac.signal);
    return () => ac.abort();
  }, []);

  return (
    <div className="composer-window-root" onContextMenu={(e) => e.preventDefault()}>
      <Composer variant="window" onContentHeight={applyHeight} onClose={close} />
    </div>
  );
}
