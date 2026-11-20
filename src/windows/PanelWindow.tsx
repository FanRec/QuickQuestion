import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { markdownToHtml } from "../lib/clipboard";
import { IconButton } from "../components/IconButton";
import { Composer } from "../components/Composer";
import { copyMarkdown, deleteExchange, errText, isSending, listExchanges } from "../lib/api";
import { emitSelect, onHotkeyInput, onRefresh } from "../lib/events";
import type { Exchange } from "../lib/types";
import { questionLabel } from "../lib/types";
import mascot from "../assets/mascot.png";
import {
  HISTORY_H,
  ORB_H,
  ORB_W,
  PANEL_W,
  noteWindowPosition,
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
  // 供长期监听读取最新形态，避免 onHotkeyInput effect 依赖 mode 反复重注册。
  const modeRef = useRef<Mode>("idle");
  const [contentH, setContentH] = useState(0);
  const [items, setItems] = useState<Exchange[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyMenu, setHistoryMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef({ x: 0, y: 0, moved: false });
  // 内嵌输入条是否正在回复中（由 Composer 上报）。收起会卸载组件、
  // 把流式气泡一起带走，所以回复期间点球/开历史都要让位。
  const inlineBusyRef = useRef(false);

  // Composer 要求稳定引用（放进 effect 依赖）。
  const setInlineBusy = useCallback((busy: boolean) => {
    inlineBusyRef.current = busy;
  }, []);

  // 离开输入形态时兜底清标志，避免卸载竞态把收起永久堵死。
  useEffect(() => {
    if (mode !== "input") inlineBusyRef.current = false;
  }, [mode]);

  // 按「今天 / 昨天 / 更早」分组，并就地按搜索词过滤。
  const groups = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    const filtered = q
      ? items.filter((i) => i.questionText.toLowerCase().includes(q))
      : items;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const todayFrom = start.getTime();
    const yesterdayFrom = todayFrom - 86_400_000;
    const buckets: Record<string, Exchange[]> = { 今天: [], 昨天: [], 更早: [] };
    for (const item of filtered) {
      if (item.createdAt >= todayFrom) buckets["今天"].push(item);
      else if (item.createdAt >= yesterdayFrom) buckets["昨天"].push(item);
      else buckets["更早"].push(item);
    }
    return Object.entries(buckets)
      .filter(([, list]) => list.length > 0)
      .map(([label, list]) => ({ label, items: list }));
  }, [items, historyQuery]);

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

  // 拖动绕过几何操作直接改 OS 窗口位置，onMoved 回填缓存，锚点才不会失真。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onMoved(({ payload }) => noteWindowPosition("panel", payload.x, payload.y))
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

  // Alt+F4/任务栏关闭会销毁无边框窗口，之后托盘拿到的 label 已不存在、悬浮球无法恢复。
  // 统一改为隐藏（main 窗口已有同样处理）。
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
          ? ORB_H + Math.max(contentH, 52) + 8
          : ORB_H;
    const width = mode === "idle" ? ORB_W : PANEL_W;
    void resizePanelKeepingAnchor(height, width);
  }, [ready, mode, contentH]);

  useEffect(() => {
    if (mode === "history") void loadHistory();
  }, [mode, loadHistory]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const ac = new AbortController();
    onRefresh(() => void loadHistory(), ac.signal);
    // Alt+Q 抢焦点：球自己的输入条若开着且没在回复，就让位收起。
    // 正在回复时不动，否则独立窗口也没法接住这轮问答。
    onHotkeyInput(() => {
      if (modeRef.current !== "input") return;
      void (async () => {
        const busy = await isSending().catch(() => false);
        if (!busy) setMode("idle");
      })();
    }, ac.signal);
    return () => ac.abort();
  }, [loadHistory]);

  const timeOf = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const dateOf = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  };

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

  // 点球时的让位规则（对独立输入条与内嵌输入条一视同仁）：
  // - 输入条开着、且没在回复 → 收起它，改用球自己的形态
  // - 输入条开着、正在回复 → 保持不动（打断/卸载都会丢回复），只把焦点给它
  const toggleInput = async () => {
    if (mode === "input") {
      if (inlineBusyRef.current) return;
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
        <div
          className="panel-history"
          onClick={(e) => {
            if (historyMenu && !(e.target as HTMLElement).closest(".panel-history-menu")) {
              setHistoryMenu(null);
            }
          }}
        >
          <div
            className="panel-history-header"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
          >
            <svg className="panel-history-clock" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" fill="none" />
              <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
            </svg>
            <span className="panel-history-title">最近的问答</span>
            <img className="panel-history-mascot" src={mascot} alt="" draggable={false} />
            <IconButton title="收起" onClick={() => setMode("idle")}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </IconButton>
          </div>

          <div className="panel-history-search">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </svg>
            <input
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="搜索历史问题…"
            />
          </div>

          {copyError && <div className="panel-history-error">{copyError}</div>}

          <div className="panel-history-list">
            {groups.length === 0 && (
              <div className="panel-history-empty">
                {historyQuery.trim() ? "没有匹配的记录" : "还没有问答记录"}
              </div>
            )}
            {groups.map((group) => (
              <div className="panel-history-group" key={group.label}>
                <div className="panel-history-group-label">
                  <span>{group.label}</span>
                  <i />
                </div>
                {group.items.map((item) => (
                  <div className="panel-history-item" key={item.id}>
                    <svg className="panel-history-doc" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                      <path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9l-6-6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
                      <path d="M13 3v6h6M8.5 13h7M8.5 16.5h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                    </svg>
                    <div className="panel-history-text">
                      <div className="panel-history-question" title={questionLabel(item)}>
                        {questionLabel(item)}
                      </div>
                      <div className="panel-history-time">
                        {group.label === "更早" ? dateOf(item.createdAt) : timeOf(item.createdAt)}
                      </div>
                    </div>
                    <div className="panel-history-actions">
                      <button
                        type="button"
                        className="panel-history-icon"
                        title={copiedId === item.id ? "已复制" : "复制问题与回复"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyItem(item.id);
                        }}
                      >
                        {copiedId === item.id ? (
                          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                            <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
                            <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="panel-history-icon"
                        title="更多"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setHistoryMenu((prev) =>
                            prev?.id === item.id
                              ? null
                              : { id: item.id, x: rect.right - 132, y: rect.bottom + 4 },
                          );
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                          <circle cx="6" cy="12" r="1.6" fill="currentColor" />
                          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                          <circle cx="18" cy="12" r="1.6" fill="currentColor" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <button
            type="button"
            className="panel-history-all"
            onClick={() => {
              void showWindow("main");
              setMode("idle");
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2h7A1.5 1.5 0 0119 9.5v8A1.5 1.5 0 0117.5 19h-13A1.5 1.5 0 013 17.5v-10z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
            </svg>
            <span>查看全部记录</span>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </div>
      )}

      {mode === "input" && (
        <div className="panel-composer">
          <Composer variant="inline" onContentHeight={setContentH} onBusyChange={setInlineBusy} />
        </div>
      )}

      {historyMenu && (
        <div
          className="panel-history-menu"
          style={{ left: historyMenu.x, top: historyMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="panel-history-menu-item"
            onClick={() => {
              void emitSelect(historyMenu.id);
              void showWindow("main");
              setHistoryMenu(null);
              setMode("idle");
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-8 8M10 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            查看这条
          </button>
          <button
            type="button"
            className="panel-history-menu-item panel-history-menu-item--danger"
            onClick={() => {
              void removeItem(historyMenu.id);
              setHistoryMenu(null);
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            删除这条
          </button>
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
          onClick={clicked(() => {
            // 内嵌输入条正在回复时切历史会卸载 Composer、丢掉回复气泡，先不让切。
            if (mode === "input" && inlineBusyRef.current) return;
            setMode(mode === "history" ? "idle" : "history");
          })}
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
