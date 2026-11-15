import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "./styles/tokens.css";
import { queryClient } from "./lib/query";
import { applyTheme, resolveTheme } from "./lib/theme";
import { router } from "./router";
import { ConfirmProvider, ToastProvider } from "./components/primitives";

// Apply the persisted theme (localStorage `sm-theme`, default dark)
// before the first paint — the inline script in index.html already did
// this; this call keeps the value in sync with the theme module.
applyTheme(resolveTheme());

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
