import { useEffect } from "react";
import { GlassCard } from "../components/GlassCard";
import { IconButton } from "../components/IconButton";
import { mockExchanges } from "../lib/mockData";
import { hideWindow, showWindow } from "../lib/windows";
import "./HistoryWindow.css";

export function HistoryWindow() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void hideWindow("history");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="history-root">
      <GlassCard className="history-card">
        <div className="history-header">
          <span className="history-title">历史问答</span>
          <IconButton title="关闭" onClick={() => hideWindow("history")}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </IconButton>
        </div>

        <div className="history-list">
          {mockExchanges.map((item) => (
            <div className="history-item" key={item.id}>
              <div className="history-item-text">
                <div className="history-question" title={item.question}>
                  {item.question}
                </div>
                <div className="history-time">{item.time}</div>
              </div>
              <div className="history-actions">
                <IconButton
                  title="展开详情"
                  variant="accent"
                  onClick={() => showWindow("main")}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <path
                      d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </IconButton>
                <IconButton title="复制问题与回复">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <rect
                      x="8"
                      y="8"
                      width="12"
                      height="12"
                      rx="2"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      fill="none"
                    />
                    <path
                      d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}
