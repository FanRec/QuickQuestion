import { useState } from "react";
import { mockExchanges } from "../lib/mockData";
import "./MainWindow.css";

export function MainWindow() {
  const [selectedId, setSelectedId] = useState(mockExchanges[0]?.id ?? "");
  const selected = mockExchanges.find((e) => e.id === selectedId);

  return (
    <div className="main-root">
      <div className="menu-bar">
        <div className="menu-brand">
          <span className="menu-logo">✦</span>
          <span>QuickQuestion</span>
        </div>
        <div className="menu-items">
          <span className="menu-item">文件</span>
          <span className="menu-item">编辑</span>
          <span className="menu-item">设置</span>
          <span className="menu-item">帮助</span>
        </div>
      </div>

      <div className="main-body">
        <aside className="main-sidebar">
          <div className="sidebar-title">全部问题</div>
          <div className="sidebar-list">
            {mockExchanges.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`sidebar-item ${item.id === selectedId ? "is-selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="sidebar-item-text">{item.question}</span>
                <span className="sidebar-item-time">{item.time}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="main-detail">
          {selected ? (
            <>
              <div className="detail-question">
                <div className="detail-label">问题</div>
                <div className="detail-question-text">{selected.question}</div>
              </div>
              <div className="detail-divider" />
              <div className="detail-answer">
                <div className="detail-label">回答</div>
                <div className="detail-answer-text">{selected.answer}</div>
              </div>
            </>
          ) : (
            <div className="detail-empty">选择左侧问题查看详情</div>
          )}
        </main>
      </div>
    </div>
  );
}
