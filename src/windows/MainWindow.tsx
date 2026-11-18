import { useCallback, useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { deleteExchange, getExchange, listExchanges } from "../lib/api";
import { onRefresh, onSelect } from "../lib/events";
import type { Exchange } from "../lib/types";
import { formatTime } from "../lib/types";
import { HelpPanel } from "./HelpPanel";
import { SettingsPanel } from "./SettingsPanel";
import "./MainWindow.css";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
type Panel = "list" | "settings" | "help";

export function MainWindow() {
  const [panel, setPanel] = useState<Panel>("list");
  const [items, setItems] = useState<Exchange[]>([]);
  const [selected, setSelected] = useState<Exchange | null>(null);

  const loadList = useCallback(async () => {
    try {
      const list = await listExchanges();
      setItems(list);
      return list;
    } catch {
      setItems([]);
      return [];
    }
  }, []);

  const select = useCallback(async (id: string) => {
    try {
      setSelected(await getExchange(id));
    } catch {
      setSelected(null);
    }
  }, []);

  useEffect(() => {
    let unlistenSelect: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    void loadList().then((list) => {
      if (list.length > 0) void select(list[0].id);
    });
    onSelect((id) => {
      setPanel("list");
      void select(id);
    }).then((fn) => {
      unlistenSelect = fn;
    });
    onRefresh(() => void loadList()).then((fn) => {
      unlistenRefresh = fn;
    });
    return () => {
      unlistenSelect?.();
      unlistenRefresh?.();
    };
  }, [loadList, select]);

  const answerHtml = useMemo(
    () => (selected ? md.render(selected.answerText) : ""),
    [selected],
  );

  return (
    <div className="main-root">
      <div className="menu-bar">
        <div className="menu-brand">
          <span className="menu-logo">✦</span>
          <span>QuickQuestion</span>
        </div>
        <div className="menu-items">
          <button type="button" className={`menu-item ${panel === "settings" ? "is-active" : ""}`} onClick={() => setPanel("settings")}>设置</button>
          <button type="button" className={`menu-item ${panel === "help" ? "is-active" : ""}`} onClick={() => setPanel("help")}>帮助</button>
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
              <div className="sidebar-title">全部问题</div>
              <div className="sidebar-list">
                {items.length === 0 && <div className="sidebar-empty">还没有问答记录</div>}
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`sidebar-item ${item.id === selected?.id ? "is-selected" : ""}`}
                    onClick={() => void select(item.id)}
                  >
                    <span className="sidebar-item-text">{item.questionText}</span>
                    <span className="sidebar-item-time">{formatTime(item.createdAt)}</span>
                  </button>
                ))}
              </div>
            </aside>

            <main className="main-detail">
              {selected ? (
                <>
                  <div className="detail-question">
                    <div className="detail-label">问题</div>
                    <div className="detail-question-text">{selected.questionText}</div>
                    {selected.imageNames.length > 0 && (
                      <div className="detail-images">
                        {selected.imageNames.map((name, i) => (
                          <span className="detail-image-chip" key={`${name}-${i}`}>
                            [图片{i + 1}] {name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="detail-divider" />
                  <div className="detail-answer">
                    <div className="detail-label">回答</div>
                    <div
                      className="detail-answer-text markdown"
                      dangerouslySetInnerHTML={{ __html: answerHtml }}
                    />
                  </div>
                  <div className="detail-actions">
                    <button
                      type="button"
                      className="detail-delete"
                      onClick={() => {
                        if (!selected) return;
                        void deleteExchange(selected.id).then(() => {
                          setSelected(null);
                          void loadList().then((list) => {
                            if (list.length > 0) void select(list[0].id);
                          });
                        });
                      }}
                    >
                      删除这条
                    </button>
                  </div>
                </>
              ) : (
                <div className="detail-empty">选择左侧问题查看详情</div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
