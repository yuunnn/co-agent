import { Link2, ShieldCheck, ShieldAlert } from "lucide-react";

const steps = [
  ["collecting", "Collecting"],
  ["deliberating", "Deliberating"],
  ["result", "Co-Result"],
];

export function CouncilHeader({ session }) {
  const controllerName = session.controller?.kind === "acp" ? "ACP client" : "Codex";
  const phase = session.result?.finalized ? "result"
    : session.phase === "opening" || session.phase === "independent" ? "collecting"
    : session.phase === "cross_examination" || session.phase === "synthesis" ? "deliberating"
      : session.phase;
  const activeIndex = Math.max(0, steps.findIndex(([id]) => id === phase));
  const quorum = session.councilStatus?.quorum;
  const totalSeats = quorum?.total || session.participants.length;
  const partial = quorum && !quorum.achieved;
  const evidenceLabel = session.evidence?.mode === "sealed"
    ? `${session.evidence.sourceCount || 0} sealed source${session.evidence.sourceCount === 1 ? "" : "s"}`
    : session.evidence?.mode === "prompt" ? "Prompt-only task" : "Read-only workspace";
  return <header className="task-header">
    <div className="binding-context"><Link2 size={16} /><span>Bound to {controllerName}</span><i />{session.controller?.threadId ? "Task connected" : "Council session"}<i />{evidenceLabel}</div>
    <h1>{session.title}</h1>
    <p>{session.objective || "Describe the decision you want the council to work through."}</p>
    {quorum && <div className={`integrity-banner ${partial ? "partial" : "verified"}`}>
      {partial ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}
      <strong>{partial ? "Partial council — no quorum" : "Independent quorum verified"}</strong>
      <span>{quorum.eligible} of {totalSeats} seats eligible · {quorum.required} required</span>
    </div>}
    <div className="progress-line" aria-label={`Current stage: ${steps[activeIndex][1]}`}>
      {steps.map(([id, label], index) => <div className={`${index === activeIndex ? "active" : ""} ${index < activeIndex ? "complete" : ""}`} key={id}>
        <span>{index + 1}. {label}</span>{index < steps.length - 1 && <i />}
      </div>)}
    </div>
  </header>;
}
