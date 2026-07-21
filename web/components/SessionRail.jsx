import { Settings, X } from "lucide-react";

function statusLabel(session) {
  if (session.councilStatus?.quorum && !session.councilStatus.quorum.achieved) return "Partial · no quorum";
  if (session.status === "completed" || session.result?.finalized) return "Completed";
  if (session.phase === "result") return "Co-Result ready";
  if (["deliberating", "cross_examination", "synthesis"].includes(session.phase)) return "Deliberating";
  return "Collecting responses";
}

function sourceLabel(session) {
  return session.controller?.kind === "acp" ? "ACP" : "Codex";
}

export function SessionRail({ sessions, activeId, view, onSelect, onSettings, onRemove }) {
  const visible = sessions.slice(0, 20);
  return <aside className="task-rail">
    <div className="brand"><span className="brand-symbol">⌘</span><strong>Co-Agent</strong></div>
    <div className="rail-heading"><strong>Bound tasks</strong><span>{visible.length}</span></div>
    <nav className="task-list" aria-label="Codex-bound council tasks">
      {visible.map((session) => <div key={session.id} className={`task-row ${view === "council" && session.id === activeId ? "active" : ""}`}>
        <button className="task-select" onClick={() => onSelect(session.id)}>
          <strong>{session.title}</strong>
          <span className="task-context"><span>{sourceLabel(session)}</span><span className={session.councilStatus?.quorum && !session.councilStatus.quorum.achieved ? "partial" : session.status}>{statusLabel(session)}</span></span>
        </button>
        <button className="task-remove" aria-label={`Remove ${session.title}`} title="Remove from history" onClick={() => onRemove(session)}><X size={16} /></button>
      </div>)}
    </nav>
    <div className="rail-footer">
      <p className="rail-note">New councils are created from Codex, not here.</p>
      <button className={`settings-link ${view === "settings" ? "active" : ""}`} onClick={onSettings}><Settings size={19} /><span>Settings</span></button>
    </div>
  </aside>;
}
