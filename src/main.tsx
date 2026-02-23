import React from "react";
import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import { App } from "./App";

// Preload Monaco so editor tabs open instantly
loader.init();

// In production builds, disable browser context menu and Cmd+R reload
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "r") e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
