import React from "react";
import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import { App } from "./App";

// Preload Monaco so editor tabs open instantly
loader.init();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
