import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { markdownToHtml } from "../lib/clipboard";
import {
  activeSession,
  cancelMessage,
  copyMarkdown,
  errText,
  getSettings,
  sendMessage,
} from "../lib/api";
import {
  emitRefresh,
  emitSelect,
  onActive,
  onHotkeyInput,
  onSettingsChanged,
  onStream,
} from "../lib/events";
import { showWindow } from "../lib/windows";
import "./Composer.css";

/** 内容高度变化时上报，宿主窗口据此调整自身尺寸。 */
export type ComposerProps = {
  /** inline：内嵌在球窗口里；window：独占一个可拖动窗口。 */
  variant: "inline" | "window";
  onContentHeight: (height: number) => void;
  /** 窗口版收起用；inline 版由球控制形态，不传。 */
  onClose?: () => void;
};

/**
 * 输入条 + 回复气泡。悬浮球内嵌一份、Alt+Q 独立窗口再跑一份，
 * 两份实例状态互不相干，但外观与行为完全一致。
 */
export function Composer({ variant, onContentHeight, onClose }: ComposerProps) {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [deepThink, setDeepThink] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [activeTitle, setActiveTitle] = useState("");
  const [exchangeId, setExchangeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 气泡自动消失秒数；0 表示永不消失。
  const [hideSecs, setHideSecs] = useState(5);
  // 独立窗口整体自动收起秒数；0 表示永不。仅 window 变体生效。
  const [popupHideSecs, setPopupHideSecs] = useState(0);
  // 每次 Alt+Q 唤起 +1，用于重置独立窗口的空闲计时。
  const [wakeTick, setWakeTick] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // 内容根节点：用它实测高度上报给宿主窗口。
  const bodyRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const streamingRef = useRef(false);
  const dragRef = useRef({ x: 0, y: 0, moved: false });

  const bubbleShown = streaming || answer !== null || error !== null;
  const needLogin = !!error && error.includes("登录");

  const refreshActive = () => {
    void activeSession()
      .then((s) => {
        setActiveId(s?.id ?? "");
        setActiveTitle(s?.title ?? "");
      })
      .catch(() => undefined);
  };

  // 配置随时可能变（设置页保存、或窗口重开），所以做成可重读的。
  const loadSettings = () => {
    void getSettings()
      .then((s) => {
        setHideSecs(s.bubbleHideSecs);
        setPopupHideSecs(s.popupHideSecs);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    inputRef.current?.focus();
    refreshActive();
    loadSettings();
    // 只在独立窗口版里响应唤起（inline 版由球的形态控制显隐）。
    if (variant !== "window") return;
    let unlistenHotkey: (() => void) | undefined;
    let unlistenSettings: (() => void) | undefined;
    onHotkeyInput(() => {
      setWakeTick((n) => n + 1);
      // 每次唤起都重读，防止用户改完设置后窗口没重新挂载。
      loadSettings();
    }).then((fn) => {
      unlistenHotkey = fn;
    });
    onSettingsChanged(loadSettings).then((fn) => {
      unlistenSettings = fn;
    });
    return () => {
      unlistenHotkey?.();
      unlistenSettings?.();
    };
  }, [variant]);

  // 内容高度用实测而非公式：公式一旦和真实渲染差几像素，窗口就会裁掉内容。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => onContentHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onContentHeight]);

  useEffect(() => {
    let unlistenStream: (() => void) | undefined;
    let unlistenActive: (() => void) | undefined;
    onStream((payload) => {
      // 只处理本实例发起的问答，避免两个实例互相污染。
      if (!streamingRef.current) return;
      if (payload.type === "delta") {
        setAnswer(payload.text);
      } else if (payload.type === "done") {
        streamingRef.current = false;
        setExchangeId(payload.exchangeId);
        setAnswer(payload.text);
        setStreaming(false);
        void emitRefresh();
        window.clearTimeout(hideTimer.current);
        if (hideSecs > 0) {
          hideTimer.current = window.setTimeout(() => setAnswer(null), hideSecs * 1000);
        }
      } else {
        streamingRef.current = false;
        setError(payload.message);
        setStreaming(false);
      }
    }).then((fn) => {
      unlistenStream = fn;
    });

    onActive((payload) => {
      setActiveId(payload.sessionId);
      refreshActive();
    }).then((fn) => {
      unlistenActive = fn;
    });

    return () => {
      unlistenStream?.();
      unlistenActive?.();
      window.clearTimeout(hideTimer.current);
    };
  }, [hideSecs]);

  // 独立窗口空闲自动收起：不打扰正在输入或正在看回复的人。
  // 条件全部不满足才开始计时，任一状态变化就取消计时。
  useEffect(() => {
    if (variant !== "window" || popupHideSecs <= 0) return;
    const busy = text.trim().length > 0 || images.length > 0 || streaming || bubbleShown;
    if (busy) return;
    const timer = window.setTimeout(() => onClose?.(), popupHideSecs * 1000);
    return () => window.clearTimeout(timer);
  }, [variant, popupHideSecs, wakeTick, text, images.length, streaming, bubbleShown, onClose]);

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      const ext = file.type.split("/")[1] || "png";
      try {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const path = await invoke<string>("save_temp_image", { bytes, ext });
        setImages((prev) => [...prev, path]);
      } catch (err) {
        setError(`粘贴图片失败：${errText(err)}`);
      }
    }
  };

  const submit = async () => {
    if (streamingRef.current) return;
    const value = text.trim();
    if (!value && images.length === 0) return;
    setAnswer("");
    setError(null);
    setExchangeId(null);
    streamingRef.current = true;
    setStreaming(true);
    setText("");
    if (inputRef.current) {
      inputRef.current.style.height = "20px";
    }
    const sentImages = images;
    setImages([]);
    try {
      await sendMessage({
        text: value,
        files: sentImages,
        deepThink,
        webSearch,
        sessionId: activeId,
        injectPrompt: newSession,
        newSession,
      });
      setNewSession(false);
    } catch (e) {
      streamingRef.current = false;
      setError(errText(e));
      setStreaming(false);
    }
  };

  // 高度变化由 ResizeObserver 自动上报，这里只管把 textarea 撑开。
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  };

  const copyAnswer = async () => {
    if (!exchangeId) return;
    try {
      const markdown = await copyMarkdown(exchangeId);
      await writeHtml(markdownToHtml(markdown), markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(`复制失败：${errText(e)}`);
    }
  };

  const openInMain = () => {
    if (!exchangeId) return;
    void emitSelect(exchangeId);
    void showWindow("main");
    if (variant === "window") onClose?.();
  };

  // 拖动：位移 >3px 才判定，避免点按钮时误拖。
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

  return (
    <div className="composer-body" ref={bodyRef}>
      {bubbleShown && (
        <div
          ref={bubbleRef}
          className={`composer-bubble${error ? " composer-bubble--error" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        >
          <div className="composer-bubble-text">{error ?? answer}</div>
          <button
            type="button"
            className="composer-bubble-close"
            title="关闭"
            onClick={() => {
              window.clearTimeout(hideTimer.current);
              setAnswer(null);
              setError(null);
            }}
          >
            <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          {needLogin && (
            <button
              type="button"
              className="composer-login-btn"
              onClick={async () => {
                try {
                  await invoke("open_login_window");
                  setError("已打开浏览器窗口，请完成登录后再发送。");
                } catch (e) {
                  setError(`打开登录窗口失败：${errText(e)}`);
                }
              }}
            >
              去登录
            </button>
          )}
        </div>
      )}

      {bubbleShown && !error && exchangeId && (
        <div className="composer-bubble-actions">
          <button type="button" className="composer-bubble-btn" onClick={() => void copyAnswer()}>
            {copied ? "已复制" : "复制"}
          </button>
          <button type="button" className="composer-bubble-btn" onClick={openInMain}>
            打开
          </button>
        </div>
      )}

      {images.length > 0 && (
        <div className="composer-image-row">
          {images.map((path) => (
            <div className="composer-image-tag" key={path}>
              <img src={convertFileSrc(path)} alt="" draggable={false} />
              <button
                type="button"
                className="composer-image-del"
                title="移除这张"
                onClick={() => setImages((prev) => prev.filter((p) => p !== path))}
              >
                <svg viewBox="0 0 24 24" width="8" height="8" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" fill="none" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {activeTitle && !newSession && <div className="composer-context">接续：{activeTitle}</div>}
      {newSession && <div className="composer-context composer-context--new">本次将开启新会话</div>}

      <div
        className="composer-input-wrap"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          placeholder="问点什么…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow(e.target);
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") {
              if (streaming) {
                void cancelMessage();
                setStreaming(false);
                streamingRef.current = false;
              } else {
                onClose?.();
              }
            }
          }}
        />
        {streaming && (
          <button
            type="button"
            className="composer-stop-btn"
            title="打断回复"
            onClick={() => {
              void cancelMessage();
              streamingRef.current = false;
              setStreaming(false);
            }}
          >
            <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`composer-mode-btn${newSession ? " composer-mode-btn--on" : ""}`}
          title={newSession ? "新会话：开（发送后自动关闭）" : "新会话：关（接续当前会话）"}
          onClick={() => setNewSession((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        <button
          type="button"
          className={`composer-mode-btn${deepThink ? " composer-mode-btn--on" : ""}`}
          title={deepThink ? "深度思考：开" : "深度思考：关"}
          onClick={() => setDeepThink((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 00-3.4 10.9c.3.2.4.5.4.9v.2h6v-.2c0-.4.1-.7.4-.9A6 6 0 0012 3z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        <button
          type="button"
          className={`composer-mode-btn${webSearch ? " composer-mode-btn--on" : ""}`}
          title={webSearch ? "联网搜索：开" : "联网搜索：关"}
          onClick={() => setWebSearch((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
            <path d="M3.5 12h17M12 3.5c2.3 2.3 3.6 5.3 3.6 8.5s-1.3 6.2-3.6 8.5c-2.3-2.3-3.6-5.3-3.6-8.5S9.7 5.8 12 3.5z" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
