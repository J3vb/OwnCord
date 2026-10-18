import { createSign } from "node:crypto";

// Installation tokens expire after an hour; two reviews plus a repair can
// outlast that. Renew only in the trusted controller, never in a model worker.
export function installationCredentials(
  { token, appID, installationID, privateKey },
  fetcher = fetch,
  now = Date.now,
) {
  if (!Number.isSafeInteger(installationID) || installationID <= 0 || !privateKey)
    throw new Error("Missing installation renewal identity");
  let current = token;
  let renewAt = now() + 45 * 60_000;
  return async () => {
    if (current && now() < renewAt) return current;
    const issued = Math.floor(now() / 1000);
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issued - 60, exp: issued + 540, iss: appID })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(payload);
    const jwt = `${payload}.${signer.sign(privateKey, "base64url")}`;
    const response = await fetcher(
      `https://api.github.com/app/installations/${installationID}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: {
            checks: "write",
            contents: "write",
            pull_requests: "write",
            actions: "write",
            administration: "read",
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error("Cannot renew controller installation token");
    const result = await response.json();
    if (!result.token || Date.parse(result.expires_at) <= now() + 5 * 60_000)
      throw new Error("Invalid renewed controller token");
    current = result.token;
    renewAt = Math.min(now() + 45 * 60_000, Date.parse(result.expires_at) - 5 * 60_000);
    return current;
  };
}

export class GitHub {
  constructor(token, repository, fetcher = fetch, credentials) {
    if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Missing GitHub controller credentials/repository");
    this.repository = repository;
    this.token = token;
    this.fetcher = fetcher;
    this.credentials = credentials ?? (async () => this.token);
  }
  async request(path, method = "GET", body) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.credentials()}`,
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
  async comments(number, inline = false) {
    const comments = await this.list(`${inline ? "pulls" : "issues"}/${number}/comments`);
    const [owner, name] = this.repository.split("/");
    const edits = new Map();
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const response = await this.fetcher("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.credentials()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: inline
            ? "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{comments(first:100){nodes{databaseId body author{__typename login} editor{__typename login} lastEditedAt} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}"
            : "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){nodes{databaseId body author{__typename login} editor{__typename login} lastEditedAt} pageInfo{hasNextPage endCursor}}}}}",
          variables: { owner, name, number, cursor },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Cannot verify comment edit provenance");
      const data = await response.json();
      const connection =
        data.data?.repository?.pullRequest?.[inline ? "reviewThreads" : "comments"];
      if (data.errors?.length || !connection?.nodes || !connection.pageInfo)
        throw new Error("Missing comment edit provenance");
      if (inline && connection.nodes.some((t) => t.comments?.pageInfo?.hasNextPage !== false))
        throw new Error("Incomplete review thread provenance");
      const nodes = inline ? connection.nodes.flatMap((t) => t.comments.nodes) : connection.nodes;
      for (const comment of nodes) edits.set(comment.databaseId, comment);
      if (!connection.pageInfo.hasNextPage) break;
      if (page === 99) throw new Error("Comment provenance pagination limit reached");
      cursor = connection.pageInfo.endCursor;
    }
    const login = (actor) =>
      actor?.__typename === "Bot" ? `${actor.login.replace(/\[bot\]$/, "")}[bot]` : actor?.login;
    return comments.map((c) => {
      const edit = edits.get(c.id);
      return {
        ...c,
        editor_verified:
          !!edit &&
          edit.body === c.body &&
          login(edit.author) === c.user?.login &&
          (!edit.lastEditedAt || login(edit.editor) === c.user?.login),
      };
    });
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
