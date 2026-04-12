import React, { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from "react-router-dom";
import { api } from "./api/index.js";
import Setup from "./pages/Setup.jsx";
import Dashboard from "./pages/Dashboard.jsx";

// Inner component so useNavigate is inside BrowserRouter
function AppRoutes() {
  const [configState, setConfigState] = useState("loading"); // "loading"|"configured"|"unconfigured"
  const navigate = useNavigate();

  useEffect(() => {
    api
      .checkConfig()
      .then(({ configured }) => {
        setConfigState(configured ? "configured" : "unconfigured");
        if (!configured) navigate("/setup", { replace: true });
      })
      .catch(() => {
        // If health check fails, still show setup so user can configure
        setConfigState("unconfigured");
        navigate("/setup", { replace: true });
      });
  }, [navigate]);

  if (configState === "loading") {
    return (
      <div style={styles.center}>
        <p>Connecting to relay server…</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <Setup
            onDone={() => {
              setConfigState("configured");
              navigate("/", { replace: true });
            }}
          />
        }
      />
      <Route
        path="/settings"
        element={
          configState === "configured" ? (
            <Setup
              mode="settings"
              onDone={() => {
                navigate("/", { replace: true });
              }}
            />
          ) : (
            <Navigate to="/setup" replace />
          )
        }
      />
      <Route
        path="/"
        element={
          configState === "configured" ? (
            <Dashboard />
          ) : (
            <Navigate to="/setup" replace />
          )
        }
      />
      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

const styles = {
  center: {
    height: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#9ca3af",
    fontSize: 14,
  },
};
