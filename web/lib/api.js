const params = new URLSearchParams(window.location.search);
export const token = params.get("token") || "";
export const launchId = params.get("launch") || "";

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

export function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

export function del(path) {
  return api(path, { method: "DELETE" });
}
