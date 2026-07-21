import { ArrowRight } from "lucide-react";

function initials(name) {
  return name.split(/\s/).map((word) => word[0]).join("").slice(0, 2);
}

function ResultList({ title, items, tone }) {
  if (!items?.length) return null;
  return <section className={`result-list ${tone}`}>
    <h2>{title}</h2>
    <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
  </section>;
}

export function Inspector({ session }) {
  const result = session.result;
  const agreements = session.agreements?.length ? session.agreements : result?.agreements || [];
  const disputes = session.disputes?.length ? session.disputes : result?.disputes || result?.dissent || [];
  const evidence = session.evidence;
  const quorum = session.councilStatus?.quorum;
  const totalSeats = quorum?.total || session.participants.length;
  return <aside className="result-rail">
    <section className="council-basis">
      <h2>Council basis</h2>
      <div className={`basis-value ${quorum?.achieved ? "verified" : "partial"}`}>
        <strong>{quorum ? `${quorum.eligible}/${totalSeats} eligible` : "Not assessed"}</strong>
        <small>{quorum?.achieved ? "Independent quorum reached" : "Consensus is not yet established"}</small>
      </div>
      <p>{evidence?.mode === "sealed" ? `${evidence.sourceCount} source${evidence.sourceCount === 1 ? "" : "s"} sealed in packet ${evidence.packetId?.slice(0, 8)}.` : evidence?.mode === "prompt" ? "No local evidence required." : "CLI seats use the bound workspace; API-only seats may be advisory."}</p>
    </section>
    <section className="participant-list">
      <h2>Participants</h2>
      {session.participants.map((person) => <div className="participant-row" key={person.id}>
        <span style={{ "--agent-color": person.color }}>{initials(person.name)}</span>
        <div>
          <strong>{person.name}</strong>
          <small>{person.model || "Configured default"}</small>
        </div>
        <em className={`seat-state ${person.seatState || "checking"}`} title={person.stateReason || person.seatState || "checking"}>{person.seatState || "checking"}</em>
      </div>)}
    </section>
    <ResultList title="Agreed" items={agreements} tone="agreed" />
    <ResultList title="Still disputed" items={disputes} tone="disputed" />
    <section className="co-result">
      <h2>Co-Result</h2>
      {result ? <>
        {result.basis === "partial-council" && <div className="partial-note">Published without independent quorum. Treat this as a host-led partial result.</div>}
        <h3>{result.outcome}</h3>
        <p>{result.summary}</p>
        {result.actions?.length > 0 && <ul>{result.actions.map((action) => <li key={action}><ArrowRight size={21} /> <span>{action}</span></li>)}</ul>}
      </> : <p className="no-result">The council is still working toward a Co-Result.</p>}
    </section>
  </aside>;
}
