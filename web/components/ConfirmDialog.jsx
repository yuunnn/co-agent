import { AlertTriangle } from "lucide-react";

export function ConfirmDialog({ session, onCancel, onConfirm, busy }) {
  if (!session) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-title">
      <AlertTriangle size={21} />
      <div>
        <h2 id="remove-title">Remove this council?</h2>
        <p><strong>{session.title}</strong> will disappear from the task list. Its files are moved to the local archive and are not permanently deleted.</p>
        <div className="dialog-actions">
          <button className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button danger" onClick={onConfirm} disabled={busy}>{busy ? "Removing…" : "Remove"}</button>
        </div>
      </div>
    </section>
  </div>;
}
