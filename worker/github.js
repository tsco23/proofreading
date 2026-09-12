/**
 * GitHub の API で原稿を読み書きする。
 * Workers には git コマンドも書き込めるディスクも無いので、clone の代わりにこれを使う。
 *
 * - 本文を読む    … GET /repos/{owner}/{repo}/contents/{path}
 * - 目次を組む    … GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 * - 指摘を書く    … PUT /repos/{owner}/{repo}/contents/{path}（これが 1 コミットになる）
 * - 前後を比べる  … 同じ contents を古いコミットの ref で読む
 */

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(String(base64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor({ token, apiBase = 'https://api.github.com', userAgent = 'proofreading-app' }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.userAgent = userAgent;
  }

  async request(path, { method = 'GET', body, accept = 'application/vnd.github+json', allow404 = false } = {}) {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'User-Agent': this.userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      let message = `GitHub ${res.status}`;
      try {
        message = `${message}: ${JSON.parse(text).message}`;
      } catch {
        if (text) message = `${message}: ${text.slice(0, 200)}`;
      }
      throw new GitHubError(res.status, message, text);
    }
    if (accept.includes('raw') || accept.includes('.sha')) return res.text();
    return res.json();
  }

  /** ブランチの先端のコミット。 */
  async headSha(novel) {
    const sha = await this.request(
      `/repos/${novel.owner}/${novel.repo}/commits/${encodeURIComponent(novel.branch)}`,
      { accept: 'application/vnd.github.sha' },
    );
    return String(sha).trim();
  }

  /** そのコミットに含まれる全ファイルの一覧。1 回で済むので目次作りに使う。 */
  async tree(novel, sha) {
    const data = await this.request(`/repos/${novel.owner}/${novel.repo}/git/trees/${sha}?recursive=1`);
    return (data.tree || []).filter((entry) => entry.type === 'blob');
  }

  /** 本文をそのまま読む。無ければ null。 */
  async fileText(novel, path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const text = await this.request(
      `/repos/${novel.owner}/${novel.repo}/contents/${encodePath(path)}${query}`,
      { accept: 'application/vnd.github.raw', allow404: true },
    );
    return text;
  }

  /** blob の中身を sha で読む（木を引いたあとの一括取得用）。 */
  async blobText(novel, sha) {
    const data = await this.request(`/repos/${novel.owner}/${novel.repo}/git/blobs/${sha}`);
    return data.encoding === 'base64' ? fromBase64(data.content) : data.content;
  }

  /** 書き換えに要る sha つきで読む。 */
  async fileWithSha(novel, path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await this.request(
      `/repos/${novel.owner}/${novel.repo}/contents/${encodePath(path)}${query}`,
      { allow404: true },
    );
    if (!data) return null;
    return { sha: data.sha, text: data.encoding === 'base64' ? fromBase64(data.content) : '' };
  }

  /** そのファイルを触ったコミットの履歴（新しい順）。 */
  async commitsFor(novel, path, limit = 20) {
    const params = new URLSearchParams({ path, sha: novel.branch, per_page: String(limit) });
    const list = await this.request(`/repos/${novel.owner}/${novel.repo}/commits?${params}`);
    return (list || []).map((c) => ({
      sha: c.sha,
      date: c.commit?.author?.date || '',
      author: c.commit?.author?.name || '',
      subject: (c.commit?.message || '').split('\n')[0],
    }));
  }

  /**
   * ファイルを書き換えてコミットする。
   * 著者は指摘した校正者。押す資格（トークン）だけがサーバのもの。
   * 誰かが先に書いていたら sha が合わずに 409 が返るので、読み直して作り直す。
   */
  async putFile(novel, { path, text, message, sha, author }) {
    const body = {
      message,
      content: toBase64(text),
      branch: novel.branch,
      ...(sha ? { sha } : {}),
      ...(author ? { author, committer: author } : {}),
    };
    const data = await this.request(`/repos/${novel.owner}/${novel.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body,
    });
    return { sha: data.commit?.sha, blobSha: data.content?.sha, pushed: true };
  }
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

export { toBase64, fromBase64 };
