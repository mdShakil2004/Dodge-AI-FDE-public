import React from "react";
import Page from "./page/Page";

// App.jsx is intentionally minimal — all state and layout live in Page.
// This keeps the entry point clean and lets you wrap Page with providers
// (React Query, context, Router) here without touching the UI layer.

const App = () => {
  return (
    <div className="app-root">
      <Page />
    </div>
  );
};

export default App;