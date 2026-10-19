// Thin client for the ranked API (server/app.js). Cookies carry the session.
async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Server ranked tidak bisa dihubungi.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const err = new Error(data?.error || 'Server ranked sedang offline.');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  nonce: () => call('/auth/nonce'),
  verify: (message, signature) => call('/auth/verify', { method: 'POST', body: { message, signature } }),
  me: () => call('/auth/me'),
  logout: () => call('/auth/logout', { method: 'POST' }),
  startGame: () => call('/game/start', { method: 'POST' }),
  finishGame: (ticket, run) => call('/game/finish', { method: 'POST', body: { ticket, ...run } }),
};
