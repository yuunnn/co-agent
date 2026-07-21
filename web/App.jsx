import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CouncilHeader } from "./components/CouncilHeader";
import { Deliberation } from "./components/Deliberation";
import { Inspector } from "./components/Inspector";
import { SessionRail } from "./components/SessionRail";
import { SettingsView } from "./components/SettingsView";
import { api, del, token } from "./lib/api";

export function App() {
  const requested = useMemo(() => new URLSearchParams(window.location.search).get("session"), []);
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(requested);
  const [session, setSession] = useState(null);
  const [config, setConfig] = useState(null);
  const [view, setView] = useState("council");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  const applyConfig = useCallback((next) => {
    setConfig(next);
    document.documentElement.dataset.theme = next.appearance.theme;
  }, []);

  const loadBootstrap = useCallback(async () => {
    const [sessionData, configData] = await Promise.all([api("/api/sessions"), api("/api/config")]);
    setSessions(sessionData.sessions);
    applyConfig(configData.config);
    setActiveId((current) => {
      if (requested && sessionData.sessions.some((item) => item.id === requested)) return requested;
      if (current && sessionData.sessions.some((item) => item.id === current)) return current;
      return sessionData.sessions[0]?.id || null;
    });
    setLoaded(true);
  }, [applyConfig, requested]);

  const loadSessions = useCallback(async () => {
    const data = await api("/api/sessions");
    setSessions(data.sessions);
  }, []);

  const loadSession = useCallback(async (id) => {
    if (!id) return;
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    setSession(data.session);
  }, []);

  useEffect(() => { loadBootstrap().catch((cause) => setError(cause.message)); }, [loadBootstrap]);
  useEffect(() => {
    if (view !== "council" || !activeId) { setSession(null); return; }
    loadSession(activeId).catch((cause) => setError(cause.message));
  }, [activeId, loadSession, view]);
  useEffect(() => {
    if (!token) return undefined;
    const socket = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.session?.id === activeId) setSession(message.session);
      if (message.type === "config.updated") applyConfig(message.config);
      if (["session.created", "session.updated", "session.deleted"].includes(message.type)) loadSessions().catch(() => {});
    };
    return () => socket.close();
  }, [activeId, applyConfig, loadSessions]);

  const selectSession = (id) => { setView("council"); setActiveId(id); };
  const removeSession = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await del(`/api/sessions/${encodeURIComponent(removeTarget.id)}`);
      const remaining = sessions.filter((item) => item.id !== removeTarget.id);
      setSessions(remaining);
      if (activeId === removeTarget.id) setActiveId(remaining[0]?.id || null);
      setRemoveTarget(null);
    } catch (cause) { setError(cause.message); }
    finally { setRemoving(false); }
  };

  if (!loaded || !config) return <div className="loading-screen"><p>{error || "Opening Co-Agent…"}</p></div>;
  return <div className={`app-shell ${view === "settings" || !session ? "wide-content" : ""}`}>
    <SessionRail sessions={sessions} activeId={activeId} view={view} onSelect={selectSession} onSettings={() => setView("settings")} onRemove={setRemoveTarget} />
    {view === "settings" ? <SettingsView config={config} onConfig={applyConfig} /> : session ? <>
      <main className="workspace"><CouncilHeader session={session} /><Deliberation session={session} /></main>
      <Inspector session={session} />
    </> : <main className="empty-workspace"><div className="empty-content"><span className="empty-link">⌁</span><h1>Open Co-Agent from Codex</h1><p>Co-Agent is a second screen for a Codex task. Start the work in Codex, then ask it to open and bind a council.</p><div className="codex-instruction"><span>Say in Codex</span><code>Open Co-Agent and bind this task.</code></div><small>Bound tasks and completed councils will appear in the left rail.</small></div></main>}
    {error && <button className="error-toast" onClick={() => setError("")}>{error}</button>}
    <ConfirmDialog session={removeTarget} busy={removing} onCancel={() => setRemoveTarget(null)} onConfirm={removeSession} />
  </div>;
}
