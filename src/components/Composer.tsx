import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { markdownToHtml } from "../lib/clipboard";
import { copyAsImage } from "../lib/copy-image";
import {
  activeSession,
  cancelMessage,
  copyMarkdown,
  errKind,
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
import { hasImageFiles, savePastedImages } from "../lib/paste";
import { showWindow } from "../lib/windows";
import mascotFace from "../assets/mascot-face.png";
import "./Composer.css";

/** 内容高度变化时上报，宿主窗口据此调整自身尺寸。 */
export type ComposerProps = {
  /** inline：内嵌在球窗口里；window：独占一个可拖动窗口。 */
  variant: "inline" | "window";
  onContentHeight: (height: number) => void;
  /** 窗口版收起用；inline 版由球控制形态，不传。 */
  onClose?: () => void;
  /** 回复状态上报：inline 版宿主据此决定收起是否要让位；不传则不上报。 */
  onBusyChange?: (busy: boolean) => void;
};

/**
 * 输入条 + 回复气泡。悬浮球内嵌一份、Alt+Q 独立窗口再跑一份，
 * 两份实例状态互不相干，但外观与行为完全一致。
 */
export function Composer({ variant, onContentHeight, onClose, onBusyChange }: ComposerProps) {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | undefined>(undefined);
  const [streaming, setStreaming] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [deepThink, setDeepThink] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [activeTitle, setActiveTitle] = useState("");
  const [exchangeId, setExchangeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState(false);
  // 独立窗口整体自动收起秒数；0 表示永不。仅 window 变体生效。
  const [popupHideSecs, setPopupHideSecs] = useState(0);
  // 每次 Alt+Q 唤起 +1，用于重置独立窗口的空闲计时。
  const [wakeTick, setWakeTick] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 内容根节点：用它实测高度上报给宿主窗口。
  const bodyRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  // hideSecs 用 ref 读取：stream effect 不依赖它，否则设置变更会触发 cleanup
  // 清掉已排定的隐藏计时器，导致当前回答永不自动消失。
  const hideSecsRef = useRef(5);
  const streamingRef = useRef(false);
  // 后端事件是全局广播；只接收本实例这一轮的事件，避免旧轮结果串进来。
  const pendingExchangeIdRef = useRef<string | null>(null);
  const dragRef = useRef({ x: 0, y: 0, moved: false });

  const bubbleShown = streaming || answer !== null || error !== null;
  // 只认结构化错误码：后端登录类错误统一带 loginRequired，不再靠文案猜。
  const needLogin = errorKind === "loginRequired";
  // 发出请求但还没收到任何流式文本：显示骨架屏，比空白气泡友好。
  const pending = streaming && !answer;

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
        hideSecsRef.current = s.bubbleHideSecs;
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
    const ac = new AbortController();
    onHotkeyInput(() => {
      setWakeTick((n) => n + 1);
      // 每次唤起都重读，防止用户改完设置后窗口没重新挂载。
      loadSettings();
      // 活跃会话可能已被主窗口切走（qq://active 只在发送后发，手动切不广播），
      // 唤起时重拉一次，避免接续显示停留在过期会话。
      refreshActive();
    }, ac.signal);
    onSettingsChanged(loadSettings, ac.signal);
    return () => ac.abort();
  }, [variant]);

  // 内容高度用实测而非公式：公式一旦和真实渲染差几像素，窗口就会裁掉内容。
  // Alt+Q 唤起时宿主会把窗口重置为占位高度，而 body 自身尺寸不变时
  // ResizeObserver 不会触发，所以唤醒和内容变化时都要主动补报一次。
  const reportHeight = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    onContentHeight(Math.ceil(el.getBoundingClientRect().height));
  }, [onContentHeight]);

  // 回复状态上报给宿主：inline 版收起会卸载本组件、把流式气泡一起带走，
  // 宿主需要知道何时该拒绝收起。
  useEffect(() => {
    onBusyChange?.(streaming);
  }, [onBusyChange, streaming]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    reportHeight();
    const ro = new ResizeObserver(reportHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reportHeight]);

  useEffect(() => {
    reportHeight();
  }, [reportHeight, wakeTick, bubbleShown, answer, error, streaming, images.length, activeTitle, newSession]);

  useEffect(() => {
    const ac = new AbortController();
    onStream((payload) => {
      // 只处理本实例发起的问答，避免两个实例互相污染。
      if (!streamingRef.current) return;
      // 后端是全局广播：只认本轮 exchangeId，旧轮残留事件直接丢。
      const mine = pendingExchangeIdRef.current;
      if (!mine || payload.exchangeId !== mine) return;
      if (payload.type === "delta") {
        setAnswer(payload.text);
      } else if (payload.type === "done") {
        streamingRef.current = false;
        setExchangeId(payload.exchangeId);
        setAnswer(payload.text);
        setStreaming(false);
        void emitRefresh();
        window.clearTimeout(hideTimer.current);
        const secs = hideSecsRef.current;
        if (secs > 0) {
          hideTimer.current = window.setTimeout(() => setAnswer(null), secs * 1000);
        }
      } else {
        streamingRef.current = false;
        setError(payload.message);
        setErrorKind(payload.kind);
        setStreaming(false);
      }
    }, ac.signal);

    onActive((payload) => {
      // payload 的 sessionId/title 是后端落库后发出的权威值，直接采用。
      // 不再回拉 active_session：那时网页 URL 可能还没切稳，空结果会把
      // sessionId 覆盖成空串，导致接续行消失、下次发送误判为新会话。
      setActiveId(payload.sessionId);
      setActiveTitle(payload.title);
    }, ac.signal);

    return () => {
      ac.abort();
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  // 独立窗口空闲自动收起：不打扰正在输入或正在看回复的人。
  // 条件全部不满足才开始计时，任一状态变化就取消计时。
  useEffect(() => {
    if (variant !== "window" || popupHideSecs <= 0) return;
    const busy = text.trim().length > 0 || images.length > 0 || streaming || bubbleShown;
    if (busy) return;
    const timer = window.setTimeout(() => onClose?.(), popupHideSecs * 1000);
    return () => window.clearTimeout(timer);
  }, [variant, popupHideSecs, wakeTick, text, images.length, streaming, bubbleShown, onClose]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // 只认粘贴进来的图片；无图片走浏览器默认粘贴。
    // preventDefault 必须在同步阶段调用，事件派发不会等 async handler。
    if (!hasImageFiles(e.clipboardData)) return;
    e.preventDefault();
    void savePastedImages(e.clipboardData).then(({ paths, errors }) => {
      setImages((prev) => [...prev, ...paths]);
      if (errors.length > 0) setError(errors.join("\n"));
    });
  };

  const submit = async () => {
    if (streamingRef.current) return;
    const value = text.trim();
    if (!value && images.length === 0) return;
    // 上一轮回答的自动隐藏计时器必须清掉：否则在 hideSecs 内连发时，
    // 旧计时器到点会把本轮新回答也 setAnswer(null) 清空。
    window.clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
    setAnswer("");
    setError(null);
    setErrorKind(undefined);
    setExchangeId(null);
    streamingRef.current = true;
    setStreaming(true);
    pendingExchangeIdRef.current = null;
    setText("");
    if (inputRef.current) {
      inputRef.current.style.height = "24px";
    }
    const sentImages = images;
    setImages([]);
    try {
      const result = await sendMessage({
        text: value,
        files: sentImages,
        deepThink,
        webSearch,
        sessionId: activeId,
        newSession,
      });
      pendingExchangeIdRef.current = result.exchangeId;
      setNewSession(false);
    } catch (e) {
      streamingRef.current = false;
      setError(errText(e));
      setErrorKind(errKind(e));
      setStreaming(false);
    }
  };

  // 打断：丢弃本轮接收。必须清 answer，否则 bubbleShown 因 answer !== null 恒真，
  // 气泡残留且 hideTimer 只在 done 分支排定，独立窗口还会因此判为 busy 永不收起。
  const cancel = () => {
    void cancelMessage();
    streamingRef.current = false;
    setStreaming(false);
    setAnswer(null);
    setExchangeId(null);
    window.clearTimeout(hideTimer.current);
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

  const pasteImage = async () => {
    if (!exchangeId) return;
    try {
      await copyAsImage(exchangeId);
      setPasted(true);
      window.setTimeout(() => setPasted(false), 1500);
    } catch (e) {
      setError(`贴图失败：${errText(e)}`);
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
          className={`composer-bubble${error ? " composer-bubble--error" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        >
          {pending ? (
            <div className="composer-skeleton" aria-busy="true">
              <div className="composer-skeleton-head">
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="currentColor" />
                </svg>
                <span>思考中…</span>
                <span className="composer-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className="composer-skeleton-lines">
                <i style={{ width: "88%" }} />
                <i style={{ width: "70%" }} />
                <i style={{ width: "46%" }} />
              </div>
              <img className="composer-skeleton-mascot" src={mascotFace} alt="" draggable={false} />
            </div>
          ) : (
            <>
              {streaming && !error && (
                <div className="composer-bubble-status">
                  <span className="composer-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  正在回答…
                </div>
              )}
              <div className="composer-bubble-text">{error ?? answer}</div>
            </>
          )}
          <button
            type="button"
            className="composer-bubble-close"
            title="关闭"
            onClick={() => {
              window.clearTimeout(hideTimer.current);
              setAnswer(null);
              setError(null);
              setErrorKind(undefined);
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
                  setError("已打开浏览器窗口，请在 DeepSeek 页面完成登录后再发送。");
                  setErrorKind(undefined);
                } catch (e) {
                  setError(`打开登录窗口失败：${errText(e)}`);
                }
              }}
            >
              去登录
            </button>
          )}
          {!error && exchangeId && (
            <div className="composer-bubble-actions">
              <div className="composer-bubble-btns">
                <button type="button" className="composer-bubble-btn" onClick={() => void copyAnswer()}>
                  <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                    <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" />
                    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                  </svg>
                  {copied ? "已复制" : "复制"}
                </button>
                <button type="button" className="composer-bubble-btn" title="渲染成图片，供 Snipaste 贴图" onClick={() => void pasteImage()}>
                  <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                    <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
                    <path d="M4 17l5-5 4 4 3-3 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                  {pasted ? "已贴图" : "贴图"}
                </button>
                <button type="button" className="composer-bubble-btn" onClick={openInMain}>
                  <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                    <path d="M14 5h5v5M19 5l-8 8M10 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                  打开
                </button>
              </div>
              {!!answer && answer.length <= 140 && (
                <img className="composer-bubble-mascot" src={mascotFace} alt="" draggable={false} />
              )}
            </div>
          )}
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

      {activeTitle && !newSession && (
        <div className="composer-context">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="currentColor" />
          </svg>
          接续：{activeTitle}
        </div>
      )}
      {newSession && (
        <div className="composer-context">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="currentColor" />
          </svg>
          本次将开启新会话
        </div>
      )}
      {!activeTitle && !newSession && (
        <div className="composer-context composer-context--muted">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="currentColor" />
          </svg>
          未接续 · 发送将开启新会话
        </div>
      )}

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
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") {
              if (streaming) {
                cancel();
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
            onClick={cancel}
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
