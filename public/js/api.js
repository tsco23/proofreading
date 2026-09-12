async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const api = {
  me: () => request('GET', '/api/me'),
  login: (loginId, password) => request('POST', '/api/auth/login', { loginId, password }),
  signup: (payload) => request('POST', '/api/auth/signup', payload),
  logout: () => request('POST', '/api/auth/logout', {}),

  novels: () => request('GET', '/api/novels'),
  toc: (novelId, { sync = false } = {}) => request('GET', `/api/novels/${novelId}/toc${sync ? '?sync=1' : ''}`),
  sync: (novelId) => request('POST', `/api/novels/${novelId}/sync`, {}),
  section: (novelId, sectionId) => request('GET', `/api/novels/${novelId}/sections/${sectionId}`),
  history: (novelId, sectionId) => request('GET', `/api/novels/${novelId}/sections/${sectionId}/history`),
  inbox: (novelId) => request('GET', `/api/novels/${novelId}/inbox`),

  annotations: (novelId, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request('GET', `/api/novels/${novelId}/annotations${q ? `?${q}` : ''}`);
  },
  addAnnotation: (novelId, payload) => request('POST', `/api/novels/${novelId}/annotations`, payload),
  compare: (novelId, annotationId) => request('GET', `/api/novels/${novelId}/annotations/${annotationId}/compare`),
  compareRevisions: (novelId, sectionId, from, to = 'HEAD') =>
    request('GET', `/api/novels/${novelId}/sections/${sectionId}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  state: (novelId) => request('GET', `/api/state/${novelId}`),
  savePosition: (novelId, position) => request('PUT', `/api/state/${novelId}/position`, position),
  addBookmark: (novelId, bookmark) => request('POST', `/api/state/${novelId}/bookmarks`, bookmark),
  removeBookmark: (novelId, bookmarkId) => request('DELETE', `/api/state/${novelId}/bookmarks/${bookmarkId}`),
};
