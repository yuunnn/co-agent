import { ArrowDownUp, CornerDownRight } from "lucide-react";

function initials(name) {
  return name.split(/\s/).map((word) => word[0]).join("").slice(0, 2);
}

export function Deliberation({ session }) {
  const participants = new Map(session.participants.map((person) => [person.id, person]));
  const visibleTypes = new Set(["agent_output", "challenge", "evidence", "position_change", "provider_error", "user_task"]);
  return <section className="conversation" aria-label="Agent deliberation">
    {session.events.filter((event) => visibleTypes.has(event.type) && (participants.has(event.actorId) || event.actorId === "user")).map((event) => {
      const person = participants.get(event.actorId);
      const changed = event.type === "position_change";
      const eligibility = event.type === "provider_error" ? "unavailable"
        : event.metadata?.eligibleForConsensus === false ? "advisory"
          : event.metadata?.eligibleForConsensus === true ? "eligible" : null;
      return <article className={`message ${changed ? "position-change" : ""} ${eligibility || ""}`} key={event.id}>
        <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        {changed ? <div className="change-icon"><ArrowDownUp size={20} /></div> : <div className="agent-avatar" style={{ "--agent-color": person?.color || "#64706d" }}>{initials(event.actorName)}</div>}
        <div className="message-content">
          <div className="message-heading"><h2>{changed ? `${event.actorName} changed position` : event.actorName}</h2>
            {event.metadata?.roundKind && <span>{event.metadata.roundKind}</span>}
            {eligibility && <span className={`eligibility ${eligibility}`}>{eligibility}</span>}
          </div>
          <p>{event.content}</p>
          {event.metadata?.replyTo && <div className="reply-note"><CornerDownRight size={16} /> Replying to {event.metadata.replyTo}</div>}
        </div>
      </article>;
    })}
  </section>;
}
