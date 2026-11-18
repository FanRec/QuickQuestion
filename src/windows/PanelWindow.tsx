import { useCallback, useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { markdownToHtml } from "../lib/clipboard";
import { IconButton } from "../components/IconButton";
import { Composer } from "../components/Composer";
import { copyMarkdown, deleteExchange, errText, isSending, listExchanges } from "../lib/api";
import { emitSelect, onHotkeyInput, onRefresh } from "../lib/events";
import type { Exchange } from "../lib/types";
import { formatTime } from "../lib/types";
import {
  HISTORY_H,
  ORB_H,
  ORB_W,
  PANEL_W,
  placePanelBottomRight,
  resizePanelKeepingAnchor,
  showWindow,
} from "../lib/windows";
import "./PanelWindow.css";

/**
 * 球窗口：球 + 内嵌输入条 + 历史，三态互斥，位置不动。
 * Alt+Q 唤起的是另一个独立窗口（composer），与这里互不干扰。
 */
type Mode = "idle" | "input" | "history";

export function PanelWindow() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [contentH, setContentH] = useState(0);
  const [items, setItems] = useState<Exchange[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const dragRef = useRef({ x: 0, y: 0, moved: false });

  const loadHistory = useCallback(async () => {
    try {
      setItems(await listExchanges());
    } catch {
      setItems([]);
    }
  }, []);

  // 首次贴右下角，定位完成后再显示，避免闪一下。
  useEffect(() => {
    void (async () => {
      try {
        await placePanelBottomRight(ORB_H);
      } finally {
        await getCurrentWindow().show();
        setReady(true);
      }
    })();
  }, []);

  // 形态变化 → 以右下角为锚调整窗口尺寸，球位置不动。
  useEffect(() => {
    if (!ready) return;
    // contentH 首帧为 0，给个兜底避免展开瞬间先矮后长；
    // 末尾 +8 是给聚焦描边（box-shadow 不占布局）和圆角抗锯齿留的余量，
    // 否则边缘会被窗口裁掉。窗口透明，多出的像素不可见。
    const height =
      mode === "history"
        ? HISTORY_H
        : mode === "input"
          ? ORB_H + Math.max(contentH, 42) + 8
          : ORB_H;
    const width = mode === "idle" ? ORB_W : PANEL_W;
    void resizePanelKeepingAnchor(height, width);
  }, [ready, mode, contentH]);

  useEffect(() => {
    if (mode === "history") void loadHistory();
  }, [mode, loadHistory]);

  useEffect(() => {
    let unlistenRefresh: (() => void) | undefined;
    let unlistenHotkey: (() => void) | undefined;
    onRefresh(() => void loadHistory()).then((fn) => {
      unlistenRefresh = fn;
    });
    // Alt+Q 抢焦点：球自己的输入条若开着且没在回复，就让位收起。
    // 正在回复时不动，否则独立窗口也没法接住这轮问答。
    onHotkeyInput(() => {
      if (mode !== "input") return;
      void (async () => {
        const busy = await isSending().catch(() => false);
        if (!busy) setMode("idle");
      })();
    }).then((fn) => {
      unlistenHotkey = fn;
    });
    return () => {
      unlistenRefresh?.();
      unlistenHotkey?.();
    };
  }, [loadHistory, mode]);

  const copyItem = async (id: string) => {
    try {
      const markdown = await copyMarkdown(id);
      await writeHtml(markdownToHtml(markdown), markdown);
      setCopiedId(id);
      setCopyError(null);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      setCopiedId(null);
      setCopyError(`复制失败：${errText(e)}`);
      window.setTimeout(() => setCopyError(null), 4000);
    }
  };

  const removeItem = async (id: string) => {
    try {
      await deleteExchange(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      setCopyError(null);
    } catch (e) {
      setCopyError(`删除失败：${errText(e)}`);
      window.setTimeout(() => setCopyError(null), 4000);
    }
  };

  // 拖动与点击共存：位移超过 3px 才判定为拖动。
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.screenX, y: e.screenY, moved: false };
  };

  const onPointerMove = async (e: React.PointerEvent) => {
    if (e.buttons !== 1 || dragRef.current.moved) return;
    const moved =
      Math.abs(e.screenX - dragRef.current.x) + Math.abs(e.screenY - dragRef.current.y) > 3;
    if (!moved) return;
    dragRef.current.moved = true;
    await getCurrentWindow().startDragging();
  };

  const clicked = (fn: () => void) => () => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    fn();
  };

  // 点球时的让位规则：
  // - 独立输入条开着、且没在回复 → 收起它，改用球自己的输入条
  // - 独立输入条开着、正在回复 → 保持不动（打断会丢回复），只把焦点给它
  const toggleInput = async () => {
    if (mode === "input") {
      setMode("idle");
      return;
    }
    const standalone = await WebviewWindow.getByLabel("composer");
    if (standalone && (await standalone.isVisible().catch(() => false))) {
      const busy = await isSending().catch(() => false);
      if (busy) {
        await standalone.setFocus();
        setMode("idle");
        return;
      }
      await standalone.hide();
    }
    setMode("input");
  };

  return (
    <div className="panel-root" onContextMenu={(e) => e.preventDefault()}>
      {mode === "history" && (
        <div className="panel-history">
          <div
            className="panel-history-header"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
          >
            <span className="panel-history-title">历史问答</span>
            {copyError && <span className="panel-history-error">{copyError}</span>}
            <IconButton title="收起" onClick={() => setMode("idle")}>
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </IconButton>
          </div>
          <div className="panel-history-list">
            {items.length === 0 && <div className="panel-history-empty">还没有问答记录</div>}
            {items.map((item) => (
              <div className="panel-history-item" key={item.id}>
                <div className="panel-history-text">
                  <div className="panel-history-question" title={item.questionText}>
                    {item.questionText}
                  </div>
                  <div className="panel-history-time">{formatTime(item.createdAt)}</div>
                </div>
                <div className="panel-history-actions">
                  <IconButton
                    title="展开详情"
                    variant="accent"
                    onClick={() => {
                      void emitSelect(item.id);
                      void showWindow("main");
                      setMode("idle");
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                    </svg>
                  </IconButton>
                  <IconButton
                    title={copiedId === item.id ? "已复制" : "复制问题与回复"}
                    onClick={() => void copyItem(item.id)}
                  >
                    {copiedId === item.id ? (
                      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                        <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" />
                        <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                      </svg>
                    )}
                  </IconButton>
                  <IconButton
                    title="删除这条"
                    onClick={() => void removeItem(item.id)}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "input" && (
        <div className="panel-composer">
          <Composer variant="inline" onContentHeight={setContentH} />
        </div>
      )}

      <div
        className="panel-orb-row"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <div
          className="orb-mini"
          title={mode === "history" ? "收起历史" : "历史记录"}
          onClick={clicked(() => setMode(mode === "history" ? "idle" : "history"))}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path
              d="M4 6h16M4 12h16M4 18h11"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </div>
        <div
          className="orb-main"
          title={mode === "input" ? "收起" : "提问"}
          onClick={clicked(() => void toggleInput())}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6L4.5 11l5.6-1.9L12 3.5z"
              fill="currentColor"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
