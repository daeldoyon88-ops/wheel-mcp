import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import Dashboard from "./dashboard.jsx";

// LAB UI banner — visible UNIQUEMENT quand le frontend tourne sur le port 5174.
// Détection runtime : aucune trace sur 5173, aucune dépendance à .env / vite.config.
function LabBanner() {
  const isLab =
    typeof window !== "undefined" && window.location.port === "5174";
  if (!isLab) return null;
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 99999,
        background: "#b91c1c",
        color: "#ffffff",
        textAlign: "center",
        padding: "6px 12px",
        fontWeight: 700,
        letterSpacing: "0.02em",
        boxShadow: "0 1px 6px rgba(0,0,0,0.4)",
      }}
    >
      🧪 LAB UI — port 5174 — ne pas utiliser pour trading réel
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LabBanner />
    <Dashboard />
  </React.StrictMode>
);
