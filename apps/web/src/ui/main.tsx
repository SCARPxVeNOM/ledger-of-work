import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installRelayWatch } from "../relay-watch.js";
import App from "./App.js";

// Before React, and long before the connector is imported: WalletConnect's transport
// reads `WebSocket` once when its module evaluates and keeps that reference, so a wrapper
// installed any later is never the one it uses.
installRelayWatch();

const el = document.getElementById("root");
if (!el) throw new Error("no #root to mount into");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
