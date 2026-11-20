import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import "katex/dist/katex.min.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { markdownToHtml } from "../lib/clipboard";
import {
  activeSession,
  cancelMessage,
  copyMarkdown,
  deleteExchange,
  deleteSession,
  errKind,
  errText,
  listExchanges,
  listSessions,
  rememberSession,
  sendMessage,
} from "../lib/api";
import { onActive, onRefresh, onSelect, onStream } from "../lib/events";
import { hasImageFiles, savePastedImages } from "../lib/paste";
import type { Exchange, Session } from "../lib/types";
import { formatTime, questionLabel } from "../lib/types";
import { HelpPanel } from "./HelpPanel";
import { SettingsPanel } from "./SettingsPanel";
import mascot from "../assets/mascot.png";
import logo from "../assets/logo.png";
import "./MainWindow.css";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(katex);
// 代码块自带头栏：语言名 + 复制按钮。按钮内容由事件委托读取 <code>，
// 不把代码副本塞进 HTML 属性；这里只负责结构。
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const lang = tokens[idx].info.trim().split(/\s+/)[0] ?? "";
  const head =
    `<div class="code-block-head">` +
    `<span class="code-lang">${lang ? md.utils.escapeHtml(lang) : ""}</span>` +
    `<button type="button" class="code-copy" data-code-copy aria-label="复制代码" title="复制代码">复制</button>` +
    `</div>`;
  return `<div class="code-block">${head}${defaultFence(tokens, idx, options, env, self)}</div>`;
};
type Panel = "list" | "settings" | "help";
type Menu =
  | { x: number; y: number; kind: "session"; sessionId: string }
  | { x: number; y: number; kind: "exchange"; exchangeId: string };

export function MainWindow() {
  const [panel, setPanel] = useState<Panel>("list");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 唯一问答真相源：所有视图（侧边栏问题列表、搜索、右侧详情）都从它派生。
  const [allExchanges, setAllExchanges] = useState<Exchange[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  // kind 决定配色：成功用低强调的绿色，失败才用危险红。
  const [notice, setNotice] = useState<{
    text: string;
    kind: "ok" | "error";
    code?: string;
  } | null>(null);

  const [draft, setDraft] = useState("");
  // 粘贴进来的图片路径；发送时交给后端上传，发送失败会回滚。
  const [images, setImages] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamQuestion, setStreamQuestion] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [deepThink, setDeepThink] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [newSession, setNewSession] = useState(false);

  const streamingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 后端 stream 是全局广播：只接受本窗口这一轮的 exchangeId。
  const pendingExchangeIdRef = useRef<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      return list;
    } catch {
      setSessions([]);
      return [];
    }
  }, []);

  const loadAll = useCallback(async (): Promise<Exchange[]> => {
    try {
      const list = await listExchanges();
      setAllExchanges(list);
      return list;
    } catch {
      setAllExchanges([]);
      return [];
    }
  }, []);

  // 单一来源派生：每个会话的问题、搜索结果、当前选中的那条。
  const bySession = useMemo(() => {
    const map = new Map<string, Exchange[]>();
    for (const ex of allExchanges) {
      const list = map.get(ex.sessionId) ?? [];
      list.push(ex);
      map.set(ex.sessionId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    return map;
  }, [allExchanges]);

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allExchanges
      .filter((e) => e.questionText.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40);
  }, [allExchanges, query]);

  const selected = useMemo(
    () => allExchanges.find((e) => e.id === selectedId) ?? null,
    [allExchanges, selectedId],
  );

  // 点标题栏 X 时只隐藏、不销毁窗口。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    void win.onCloseRequested((event) => {
      event.preventDefault();
      void win.hide();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 首次进入：恢复上次选中的会话，选中该会话最新一条。
  useEffect(() => {
    void (async () => {
      const [sessions, all] = await Promise.all([loadSessions(), loadAll()]);
      const settings = await invoke<{ lastSessionId: string }>("get_settings")
        .catch(() => ({ lastSessionId: "" }));
      const chosen = sessions.find((s) => s.id === settings.lastSessionId) ?? sessions[0];
      if (chosen) {
        setCurrentId(chosen.id);
        setExpanded(new Set([chosen.id]));
      }
      const mine = all.filter((e) => e.sessionId === chosen?.id);
      if (mine.length) setSelectedId(mine[mine.length - 1].id);
      const active = await activeSession().catch(() => null);
      if (active) setActiveId(active.id);
    })();
  }, [loadSessions, loadAll]);

  useEffect(() => {
    if (currentId) void rememberSession(currentId).catch(() => undefined);
  }, [currentId]);

  useEffect(() => {
    const ac = new AbortController();
    void Promise.all([
      onSelect((id) => {
        // 从悬浮面板「打开」过来：定位到该问答所属会话与那条问答。
        setPanel("list");
        void listExchanges().then((all) => {
          const hit = all.find((e) => e.id === id);
          if (hit) {
            setCurrentId(hit.sessionId);
            setSelectedId(hit.id);
            setExpanded(new Set([hit.sessionId]));
            void loadSessions();
          }
        });
      }, ac.signal),
      onRefresh(() => {
        void loadSessions();
        void loadAll();
      }, ac.signal),
      onActive((payload) => {
        setActiveId(payload.sessionId);
        void loadSessions();
      }, ac.signal),
      onStream((payload) => {
        if (!streamingRef.current) return;
        const mine = pendingExchangeIdRef.current;
        if (!mine || payload.exchangeId !== mine) return;
        if (payload.type === "delta") {
          setStreamAnswer(payload.text);
        } else if (payload.type === "done") {
          streamingRef.current = false;
          setStreaming(false);
          setStreamQuestion("");
          setStreamAnswer("");
          setSelectedId(payload.exchangeId);
          void loadAll();
          void loadSessions();
        } else {
          streamingRef.current = false;
          setStreaming(false);
          setNotice({ text: payload.message, kind: "error", code: payload.kind });
        }
      }, ac.signal),
    ]);
    return () => ac.abort();
  }, [loadAll, loadSessions]);

  // 选中项变化时滚动到顶部（单条展示，无需跟随流式滚动）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [selectedId]);

  const selectExchange = (sessionId: string, exchangeId: string) => {
    setCurrentId(sessionId);
    setSelectedId(exchangeId);
    setPanel("list");
    setNotice(null);
  };

  // 切会话必须同时定 currentId（左栏高亮/发送归属）与 selectedId（右侧详情）。
  // 只设前者会让右栏继续显示上一个会话的问答，出现"人在 B、内容是 A"。
  // 空会话没有问答，selectedId 置空，右栏走 detail-empty。
  const focusSession = (sessionId: string) => {
    const mine = bySession.get(sessionId) ?? [];
    setCurrentId(sessionId);
    setSelectedId(mine.length ? mine[mine.length - 1].id : null);
    setNotice(null);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeSession = async (id: string) => {
    setMenu(null);
    try {
      await deleteSession(id);
      await Promise.all([loadSessions(), loadAll()]);
      if (currentId === id) {
        setCurrentId(null);
        setSelectedId(null);
      }
    } catch (e) {
      setNotice({ text: `删除会话失败：${errText(e)}`, kind: "error" });
    }
  };

  const removeExchange = async (id: string) => {
    setMenu(null);
    try {
      await deleteExchange(id);
      if (selectedId === id) setSelectedId(null);
      await loadAll();
    } catch (e) {
      setNotice({ text: `删除失败：${errText(e)}`, kind: "error" });
    }
  };

  const copyExchange = async (id: string) => {
    setMenu(null);
    try {
      const markdown = await copyMarkdown(id);
      await writeHtml(markdownToHtml(markdown), markdown);
      setNotice({ text: "已复制", kind: "ok" });
      window.setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setNotice({ text: `复制失败：${errText(e)}`, kind: "error" });
    }
  };

  // 代码块复制：按钮是渲染进 innerHTML 的真实 button，这里做事件委托。
  const copyCode = (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-code-copy]");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void writeText(code).then(
      () => {
        btn.textContent = "已复制";
        btn.classList.add("is-copied");
        window.setTimeout(() => {
          btn.textContent = "复制";
          btn.classList.remove("is-copied");
        }, 1500);
      },
      () => {
        btn.textContent = "复制失败";
        btn.classList.add("is-error");
        window.setTimeout(() => {
          btn.textContent = "复制";
          btn.classList.remove("is-error");
        }, 3000);
      },
    );
  };

  // markdown 区点击：链接一律开系统浏览器——网页内的 <a> 若不拦截，
  // 会把本窗口导航到外部站点，应用 UI 直接丢失，外部页面还带着 IPC 权限运行。
  const onMarkdownClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest("a");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      void openUrl(href).catch((err) =>
        setNotice({ text: `打开链接失败：${errText(err)}`, kind: "error" }),
      );
      return;
    }
    copyCode(e);
  };

  // 与悬浮输入条一致：只认粘贴进来的图片，文字粘贴走浏览器默认行为。
  // preventDefault 必须在同步阶段调用，事件派发不会等 async handler。
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasImageFiles(e.clipboardData)) return;
    e.preventDefault();
    void savePastedImages(e.clipboardData).then(({ paths, errors }) => {
      setImages((prev) => [...prev, ...paths]);
      if (errors.length > 0) {
        setNotice({ text: errors.join("\n"), kind: "error" });
        window.setTimeout(() => setNotice(null), 4000);
      }
    });
  };

  const send = async () => {
    if (streamingRef.current) return;
    const value = draft.trim();
    const sentImages = images;
    if (!value && sentImages.length === 0) return;

    setDraft("");
    setImages([]);
    setNotice(null);
    setStreamQuestion(value || (sentImages.length ? "[图片]" : ""));
    setStreamAnswer("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    streamingRef.current = true;
    pendingExchangeIdRef.current = null;
    setStreaming(true);
    try {
      const result = await sendMessage({
        text: value,
        files: sentImages,
        deepThink,
        webSearch,
        sessionId: currentId ?? "",
        newSession,
      });
      pendingExchangeIdRef.current = result.exchangeId;
      setNewSession(false);
      setCurrentId(result.sessionId);
      setExpanded((prev) => new Set(prev).add(result.sessionId));
      void loadSessions();
    } catch (e) {
      streamingRef.current = false;
      setStreaming(false);
      setImages(sentImages);
      setNotice({ text: errText(e), kind: "error", code: errKind(e) });
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div
      className="main-root"
      onClick={() => menu && setMenu(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-bar" data-tauri-drag-region>
        <div className="menu-brand" data-tauri-drag-region>
          <img className="menu-logo" src={logo} alt="" draggable={false} />
          <span>QuickQuestion</span>
        </div>
        <div className="menu-right">
          <div className="menu-items">
            <button
              type="button"
              className={`menu-item ${panel === "list" ? "is-active" : ""}`}
              onClick={() => setPanel("list")}
            >
              会话
            </button>
            <button
              type="button"
              className={`menu-item ${panel === "settings" ? "is-active" : ""}`}
              onClick={() => setPanel(panel === "settings" ? "list" : "settings")}
            >
              设置
            </button>
            <button
              type="button"
              className={`menu-item ${panel === "help" ? "is-active" : ""}`}
              onClick={() => setPanel(panel === "help" ? "list" : "help")}
            >
              帮助
            </button>
          </div>
          <div className="win-controls">
            <button
              type="button"
              className="win-btn"
              title="最小化"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M5 12h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn"
              title="最大化 / 还原"
              onClick={() => void getCurrentWindow().toggleMaximize()}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn win-btn--close"
              title="隐藏到托盘"
              onClick={() => void getCurrentWindow().hide()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="main-body">
        {panel === "settings" ? (
          <SettingsPanel />
        ) : panel === "help" ? (
          <HelpPanel />
        ) : (
          <>
            <aside className="main-sidebar">
              <div className="sidebar-head">
                <span className="sidebar-title">会话</span>
                {activeId && <span className="sidebar-active-tag">当前网页</span>}
              </div>
              <div className="sidebar-search">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索问题…"
                />
              </div>
              <div className="sidebar-list">
                {query.trim() ? (
                  searchHits.length === 0 ? (
                    <div className="sidebar-empty">没有匹配的问题</div>
                  ) : (
                    searchHits.map((hit) => (
                      <button
                        type="button"
                        key={hit.id}
                        className={`sidebar-hit${hit.id === selectedId ? " is-selected" : ""}`}
                        onClick={() => selectExchange(hit.sessionId, hit.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMenu({ x: e.clientX, y: e.clientY, kind: "exchange", exchangeId: hit.id });
                        }}
                      >
                        <span className="sidebar-hit-q">{questionLabel(hit)}</span>
                        <span className="sidebar-hit-meta">
                          {sessions.find((s) => s.id === hit.sessionId)?.title ?? "会话"} · {formatTime(hit.createdAt)}
                        </span>
                      </button>
                    ))
                  )
                ) : (
                  <>
                    {sessions.length === 0 && <div className="sidebar-empty">还没有会话</div>}
                    {sessions.map((s) => {
                      const open = expanded.has(s.id);
                      const questions = bySession.get(s.id) ?? [];
                      return (
                        <div key={s.id} className={`sidebar-group${s.id === currentId ? " is-selected" : ""}`}>
                          <div
                            className="sidebar-group-head"
                            onClick={() => {
                              toggleExpanded(s.id);
                              focusSession(s.id);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setMenu({ x: e.clientX, y: e.clientY, kind: "session", sessionId: s.id });
                            }}
                          >
                            <span className="sidebar-caret">{open ? "▾" : "▸"}</span>
                            <span className={`sidebar-dot${s.deepseekChatId ? " is-bound" : ""}`} />
                            <span className="sidebar-group-title">{s.title || "未命名会话"}</span>
                            {s.id === activeId && <span className="sidebar-active-dot" title="网页当前所在会话" />}
                            <span className="sidebar-item-time">{formatTime(s.updatedAt)}</span>
                          </div>
                          {open && (
                            <div className="sidebar-questions">
                              {questions.map((ex) => (
                                <button
                                  type="button"
                                  key={ex.id}
                                  className={`sidebar-question${ex.id === selectedId ? " is-selected" : ""}`}
                                  onClick={() => selectExchange(s.id, ex.id)}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setMenu({ x: e.clientX, y: e.clientY, kind: "exchange", exchangeId: ex.id });
                                  }}
                                  title={questionLabel(ex)}
                                >
                                  {questionLabel(ex)}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              <div className="sidebar-footer">
                <img className="sidebar-mascot" src={mascot} alt="" draggable={false} />
              </div>
            </aside>

            <main className="main-detail">
              {selected && !streaming && (
                <button
                  type="button"
                  className="detail-copy"
                  title="复制这条问答（富文本，可直接贴图）"
                  onClick={() => void copyExchange(selected.id)}
                >
                  {notice?.kind === "ok" ? "已复制" : "复制"}
                </button>
              )}
              <div className="detail-scroll" ref={scrollRef}>
                {streaming && (
                  <div className="turn">
                    <div className="turn-question">{streamQuestion}</div>
                    <div className="turn-answer detail-streaming">
                      {streamAnswer || "正在思考…"}
                    </div>
                  </div>
                )}

                {!streaming && selected && (
                  <div className="turn">
                    <div className="turn-context">
                      {sessions.find((s) => s.id === selected.sessionId)?.title ?? "会话"}
                      {selected.sessionId === activeId && <span className="turn-context-active"> · 网页当前在此</span>}
                    </div>
                    <div className="turn-question">{questionLabel(selected)}</div>
                    <div
                      className="turn-answer markdown"
                      onClick={onMarkdownClick}
                      dangerouslySetInnerHTML={{ __html: md.render(selected.answerText) }}
                    />
                  </div>
                )}

                {!streaming && !selected && (
                  <div className="detail-empty">从左侧选一条问题查看，或在下方提问</div>
                )}

                {notice && (
                  <div className={`detail-notice ${notice.kind === "ok" ? "is-ok" : "is-error"}`}>
                    <span>{notice.text}</span>
                    {notice.code === "loginRequired" && (
                      <button
                        type="button"
                        className="detail-notice-action"
                        onClick={() => {
                          void invoke("open_login_window").then(
                            () => setNotice(null),
                            (e) => setNotice({ text: `打开登录窗口失败：${errText(e)}`, kind: "error" }),
                          );
                        }}
                      >
                        去登录
                      </button>
                    )}
                  </div>
                )}
              </div>

              {(activeId || newSession) && (
                <div className={`detail-context${newSession ? " is-new" : ""}`}>
                  {newSession
                    ? "本次将开启新会话"
                    : `接续：${sessions.find((s) => s.id === activeId)?.title ?? "网页当前会话"}`}
                </div>
              )}
              <div className="detail-compose">
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
                <div className="detail-composer">
                  <textarea
                  ref={composerRef}
                  className="main-input"
                  rows={1}
                  placeholder="提问…（Shift+Enter 换行）"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    autoGrow(e.target);
                  }}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  type="button"
                  className={`main-mode-btn${newSession ? " is-on" : ""}`}
                  title={newSession ? "新会话：开（发送后自动关闭）" : "新会话：关（接续当前会话）"}
                  onClick={() => setNewSession((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`main-mode-btn${deepThink ? " is-on" : ""}`}
                  title={deepThink ? "深度思考：开" : "深度思考：关"}
                  onClick={() => setDeepThink((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 00-3.4 10.9c.3.2.4.5.4.9v.2h6v-.2c0-.4.1-.7.4-.9A6 6 0 0012 3z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`main-mode-btn${webSearch ? " is-on" : ""}`}
                  title={webSearch ? "联网搜索：开" : "联网搜索：关"}
                  onClick={() => setWebSearch((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
                    <path d="M3.5 12h17M12 3.5c2.3 2.3 3.6 5.3 3.6 8.5s-1.3 6.2-3.6 8.5c-2.3-2.3-3.6-5.3-3.6-8.5S9.7 5.8 12 3.5z" stroke="currentColor" strokeWidth="1.3" fill="none" />
                  </svg>
                </button>
                {streaming ? (
                  <button
                    type="button"
                    className="main-stop"
                    title="打断回复"
                    onClick={() => {
                      void cancelMessage();
                      streamingRef.current = false;
                      setStreaming(false);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                    </svg>
                  </button>
                ) : (
                  <button type="button" className="main-send" title="发送" onClick={() => void send()}>
                    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                      <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                )}
                </div>
              </div>
            </main>
          </>
        )}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === "session" ? (
            <>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  focusSession(menu.sessionId);
                  setMenu(null);
                }}
              >
                切换到该会话
              </button>
              <div className="ctx-divider" />
              <button
                type="button"
                className="ctx-item ctx-item--danger"
                onClick={() => void removeSession(menu.sessionId)}
              >
                删除整个会话
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  const hit = allExchanges.find((e) => e.id === menu.exchangeId);
                  if (hit) selectExchange(hit.sessionId, hit.id);
                  setMenu(null);
                }}
              >
                查看这条
              </button>
              <button
                type="button"
                className="ctx-item"
                onClick={() => void copyExchange(menu.exchangeId)}
              >
                复制这条
              </button>
              <div className="ctx-divider" />
              <button
                type="button"
                className="ctx-item ctx-item--danger"
                onClick={() => void removeExchange(menu.exchangeId)}
              >
                删除这条
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
