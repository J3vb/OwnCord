export class GitHub {
  constructor(token, repository, fetcher = fetch) {
    if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Missing GitHub controller credentials/repository");
    this.repository = repository;
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(path, method = "GET", body) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path.split("?")[0]} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async list(path, key) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw new Error("Invalid GitHub list response");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error("GitHub pagination limit reached");
  }
  async checks(sha) {
    return this.list(`commits/${sha}/check-runs?filter=all`, "check_runs");
  }
  async content(path, sha) {
    const data = await this.request(
      `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
    );
    if (data.encoding !== "base64" || typeof data.content !== "string")
      throw new Error(`Cannot read review context: ${path}`);
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  async check(name, head, appID, status, title, state = {}) {
    const runs = await this.checks(head);
    const existing = runs
      .filter((r) => r.name === name && r.app?.id === appID)
      .sort((a, b) => b.id - a.id)[0];
    const payload = {
      name,
      head_sha: head,
      status: status === "pending" ? "in_progress" : "completed",
      output: {
        title,
        summary: `Controller receipt\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
      },
    };
    if (status !== "pending") {
      payload.conclusion = status;
      payload.completed_at = new Date().toISOString();
    }
    return this.request(
      existing ? `check-runs/${existing.id}` : "check-runs",
      existing ? "PATCH" : "POST",
      payload,
    );
  }
}

export function receipt(checks, name, appID) {
  const c = checks
    .filter((r) => r.name === name && r.app?.id === appID)
    .sort((a, b) => b.id - a.id)[0];
  try {
    return JSON.parse(c?.output?.summary.match(/```json\n([^]*?)\n```/)?.[1]);
  } catch {
    return null;
  }
}
