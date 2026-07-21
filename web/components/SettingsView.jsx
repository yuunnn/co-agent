import { useEffect, useState } from "react";
import { Check, CircleAlert, Eye, EyeOff, LoaderCircle, Pencil, Plus, Radio, ShieldCheck, Trash2 } from "lucide-react";
import { api, del, post } from "../lib/api";

const THEMES = [
  { id: "co-agent-dark", label: "Co-Agent Dark" },
  { id: "gruvbox-dark", label: "Gruvbox Dark" },
  { id: "classic-light", label: "Classic Light" },
];

const EMPTY_API_FORM = { name: "", baseUrl: "", model: "", token: "", enabled: false };
const EMPTY_AGENT_FORM = { name: "", command: "", enabled: true };

function StatusIcon({ status }) {
  if (status === "testing") return <LoaderCircle className="spin" size={16} />;
  if (status?.ok) return <Check size={16} />;
  if (status?.error) return <CircleAlert size={16} />;
  return null;
}

export function SettingsView({ config, onConfig }) {
  const [agents, setAgents] = useState([]);
  const [apiForm, setApiForm] = useState(null);
  const [agentForm, setAgentForm] = useState(null);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadAgents = () => api("/api/providers/agents").then((data) => setAgents(data.providers));

  useEffect(() => { loadAgents().catch((cause) => setError(cause.message)); }, []);

  const setTheme = async (theme) => {
    try {
      const data = await post("/api/config/theme", { theme });
      onConfig(data.config);
    } catch (cause) { setError(cause.message); }
  };

  const saveApiProvider = async (event) => {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const data = await post("/api/providers/api", apiForm);
      onConfig(data.config);
      if (data.provider?.id) setTesting((current) => ({ ...current, [`api:${data.provider.id}`]: data.result }));
      setApiForm(null); setShowToken(false);
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  };

  const saveAgentProvider = async (event) => {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const data = await post("/api/providers/agents", agentForm);
      onConfig(data.config);
      if (data.provider?.id) setTesting((current) => ({ ...current, [`agents:${data.provider.id}`]: data.result }));
      setAgentForm(null);
      await loadAgents();
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  };

  const testProvider = async (kind, id) => {
    const key = `${kind}:${id}`;
    setTesting((current) => ({ ...current, [key]: "testing" }));
    try {
      const data = await post(`/api/providers/${kind}/${encodeURIComponent(id)}/test`, {});
      setTesting((current) => ({ ...current, [key]: data.result }));
    } catch (cause) {
      setTesting((current) => ({ ...current, [key]: { ok: false, error: cause.message } }));
    }
  };

  const removeApiProvider = async (id) => {
    try {
      const data = await del(`/api/providers/api/${encodeURIComponent(id)}`);
      onConfig(data.config);
      if (apiForm?.id === id) setApiForm(null);
    } catch (cause) { setError(cause.message); }
  };

  const removeAgentProvider = async (id) => {
    try {
      const data = await del(`/api/providers/agents/${encodeURIComponent(id)}`);
      onConfig(data.config);
      if (agentForm?.id === id) setAgentForm(null);
      await loadAgents();
    } catch (cause) { setError(cause.message); }
  };

  const toggleProvider = async (provider) => {
    try {
      const data = await post(`/api/providers/api/${encodeURIComponent(provider.id)}/enabled`, { enabled: !provider.enabled });
      onConfig(data.config);
    } catch (cause) { setError(cause.message); }
  };

  const toggleAgentProvider = async (provider) => {
    try {
      const data = await post(`/api/providers/agents/${encodeURIComponent(provider.id)}/enabled`, { enabled: !provider.enabled });
      onConfig(data.config);
      await loadAgents();
    } catch (cause) { setError(cause.message); }
  };

  return <main className="settings-view">
    <header className="settings-header"><h1>Settings</h1><p>Configure appearance and provider connections.</p></header>
    <section className="settings-section appearance-section">
      <h2>Appearance</h2>
      <div className="theme-selector">{THEMES.map((theme) => <button key={theme.id} className={config.appearance.theme === theme.id ? "active" : ""} onClick={() => setTheme(theme.id)}>{config.appearance.theme === theme.id && <Check size={16} />}{theme.label}</button>)}</div>
    </section>
    <section className="settings-section providers-section">
      <div className="section-heading"><div><h2>Providers</h2><p>Connect API models or reuse agent CLIs already available in your terminal.</p></div></div>
      <div className="provider-group">
        <div className="provider-group-heading"><div><h3>API providers</h3><p>Enable any number of independent API seats. Each uses <code>POST /chat/completions</code> with Bearer authentication.</p></div><button className="button secondary" onClick={() => setApiForm({ ...EMPTY_API_FORM })}><Plus size={16} /> Add API provider</button></div>
        <div className="provider-table api-table">
          <div className="provider-table-head"><span>Name</span><span>Model</span><span>Base URL</span><span>New councils</span><span>Actions</span></div>
          {config.apiProviders.length === 0 ? <p className="provider-empty">No API provider configured. Add and enable one or more model endpoints to create independent council seats.</p> : config.apiProviders.map((provider) => {
            const result = testing[`api:${provider.id}`];
            return <div className="provider-row" key={provider.id}>
              <span><strong>{provider.name}</strong><small>{provider.hasToken ? "Token stored locally" : "Token required"}</small></span>
              <code>{provider.model}</code><span className="truncate" title={provider.baseUrl}>{provider.baseUrl}</span>
              <label className={`provider-seat-toggle ${provider.enabled ? "enabled-seat" : "muted-seat"}`}><input type="checkbox" checked={provider.enabled} onChange={() => toggleProvider(provider)} /><span>{provider.enabled ? "Included" : "Not included"}</span></label>
              <span className="provider-actions">
                <button title="Edit provider" onClick={() => setApiForm({ ...provider, token: "" })}><Pencil size={15} /></button>
                <button className="test-button" onClick={() => testProvider("api", provider.id)}><StatusIcon status={result} />{result?.ok ? `${result.model} · ${result.durationMs}ms` : result?.error || "Test connection"}</button>
                <button title="Delete provider" onClick={() => removeApiProvider(provider.id)}><Trash2 size={15} /></button>
              </span>
            </div>;
          })}
        </div>
        {apiForm && <form className="provider-form" onSubmit={saveApiProvider}>
          <div className="form-grid">
            <label><span>Name</span><input value={apiForm.name} onChange={(event) => setApiForm({ ...apiForm, name: event.target.value })} placeholder="My API provider" required /></label>
            <label><span>Base URL</span><input value={apiForm.baseUrl} onChange={(event) => setApiForm({ ...apiForm, baseUrl: event.target.value })} placeholder="https://api.provider.com/v1" required /></label>
            <label><span>Model</span><input value={apiForm.model} onChange={(event) => setApiForm({ ...apiForm, model: event.target.value })} placeholder="model-id" required /></label>
            <label><span>API token</span><div className="token-input"><input type={showToken ? "text" : "password"} value={apiForm.token} onChange={(event) => setApiForm({ ...apiForm, token: event.target.value })} placeholder={apiForm.hasToken ? "Leave blank to keep stored token" : "Required"} required={!apiForm.hasToken} /><button type="button" onClick={() => setShowToken((value) => !value)} aria-label={showToken ? "Hide token" : "Show token"}>{showToken ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          </div>
          <label className="council-seat-toggle"><input type="checkbox" checked={apiForm.enabled} onChange={(event) => setApiForm({ ...apiForm, enabled: event.target.checked })} /><Radio size={16} /><span>Include as an independent API seat in new councils</span></label>
          <div className="form-actions"><button type="button" className="button secondary" onClick={() => setApiForm(null)}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Testing…" : apiForm.id ? "Test & save" : "Test & add provider"}</button></div>
        </form>}
      </div>
      <div className="provider-group agent-group">
        <div className="provider-group-heading"><div><h3>Agent providers</h3><p>Add supported CLI commands from your terminal. Co-Agent verifies a real response before saving and never applies a model override.</p></div><button className="button secondary" onClick={() => setAgentForm({ ...EMPTY_AGENT_FORM })}><Plus size={16} /> Add terminal agent</button></div>
        <div className="provider-table agent-table">
          <div className="provider-table-head"><span>Name</span><span>Command</span><span>Type / Status</span><span>New councils</span><span>Actions</span></div>
          {agents.length === 0 && <p className="provider-empty">No terminal agent configured. Add <code>claude</code>, <code>cursor-agent</code>, or <code>opencode</code>.</p>}
          {agents.map((agent) => {
            const result = testing[`agents:${agent.id}`];
            return <div className="provider-row" key={agent.id}>
              <span><strong>{agent.name}</strong><small>{agent.adapter}</small></span><code className="truncate" title={agent.command}>{agent.command}</code><span className={`agent-availability ${agent.status}`}>{agent.status === "available" ? <Check size={15} /> : <CircleAlert size={15} />}{agent.version}</span>
              <label className={`provider-seat-toggle ${agent.enabled ? "enabled-seat" : "muted-seat"}`}><input type="checkbox" checked={agent.enabled} onChange={() => toggleAgentProvider(agent)} /><span>{agent.enabled ? "Included" : "Not included"}</span></label>
              <span className="provider-actions">
                <button title="Edit agent" onClick={() => setAgentForm({ id: agent.id, name: agent.name, command: agent.command, enabled: agent.enabled })}><Pencil size={15} /></button>
                <button className="test-button" onClick={() => testProvider("agents", agent.id)}><StatusIcon status={result} />{result?.ok ? `${result.model} · ${result.durationMs}ms` : result?.error || "Test connection"}</button>
                <button title="Delete agent" onClick={() => removeAgentProvider(agent.id)}><Trash2 size={15} /></button>
              </span>
            </div>;
          })}
        </div>
        {agentForm && <form className="provider-form agent-form" onSubmit={saveAgentProvider}>
          <div className="form-grid">
            <label><span>Name</span><input value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} placeholder="My coding agent" required /></label>
            <label><span>Command</span><input value={agentForm.command} onChange={(event) => setAgentForm({ ...agentForm, command: event.target.value })} placeholder="claude" required /><small>Supported: claude, cursor-agent, opencode. Absolute executable paths are accepted.</small></label>
          </div>
          <label className="council-seat-toggle"><input type="checkbox" checked={agentForm.enabled} onChange={(event) => setAgentForm({ ...agentForm, enabled: event.target.checked })} /><Radio size={16} /><span>Include as an independent Agent seat in new councils</span></label>
          <div className="form-actions"><button type="button" className="button secondary" onClick={() => setAgentForm(null)}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Testing…" : agentForm.id ? "Test & save" : "Test & add agent"}</button></div>
        </form>}
      </div>
      <p className="security-note"><ShieldCheck size={17} /> Tokens are stored in a local permission-restricted file and are never returned by the settings API.</p>
      {error && <p className="settings-error">{error}</p>}
    </section>
  </main>;
}
