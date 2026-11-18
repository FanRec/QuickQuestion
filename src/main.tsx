import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { PanelWindow } from "./windows/PanelWindow";
import { ComposerWindow } from "./windows/ComposerWindow";
import { MainWindow } from "./windows/MainWindow";
import { applyTheme, loadTheme, watchTheme } from "./lib/theme";

const windowId = new URLSearchParams(window.location.search).get("window");
applyTheme(loadTheme());
watchTheme();

function App() {
  switch (windowId) {
    case "main":
      return <MainWindow />;
    case "composer":
      return <ComposerWindow />;
    case "panel":
    default:
      return <PanelWindow />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
