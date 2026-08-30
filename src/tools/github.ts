/**
 * GitHub repo provisioning — port of worker/tools/github.py.
 *
 * File transfer and the git push happen inside the sandbox; this module only
 * ensures the remote repo exists (create-if-missing) and exposes clone/html URLs.
 */
import { getSettings } from "../config/settings.ts";

function quote(s: string): string {
  return encodeURIComponent(s);
}

export interface RemoteRepo {
  name: string;
  html_url: string;
  clone_url: string;
  token: string;
  org: string;
}

export class GitHubRepository {
  readonly token: string;
  readonly org: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor() {
    const s = getSettings();
    if (!s.GITHUB_ACCESS_TOKEN) throw new Error("GITHUB_ACCESS_TOKEN is not configured");
    this.token = s.GITHUB_ACCESS_TOKEN;
    this.org = s.GITHUB_ORG;
    this.baseUrl = s.GITHUB_API_URL.replace(/\/$/, "");
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  htmlUrl(repoName: string): string {
    return `https://github.com/${this.org}/${repoName}`;
  }

  private repoUrl(repoName: string): string {
    return `${this.baseUrl}/repos/${quote(this.org)}/${quote(repoName)}`;
  }

  get cloneUrlPrefix(): string {
    return `https://github.com/${this.org}`;
  }

  async ensure(repoName: string, description = "Polaris paper reproduction"): Promise<RemoteRepo> {
    const s = getSettings();
    const get = await fetch(this.repoUrl(repoName), { headers: this.headers });
    if (get.status === 200) {
      const j = (await get.json()) as Record<string, unknown>;
      return this.toRemote(repoName, j);
    }
    if (get.status !== 404) {
      throw new Error(`GitHub GET repo failed: ${get.status} ${await get.text().catch(() => "")}`);
    }

    const create = await fetch(`${this.baseUrl}/orgs/${quote(this.org)}/repos`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: repoName,
        description,
        private: s.GITHUB_REPO_PRIVATE,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      }),
    });
    // a concurrent worker may have created it after our GET
    if (create.status === 422) {
      const retry = await fetch(this.repoUrl(repoName), { headers: this.headers });
      if (!retry.ok) throw new Error(`GitHub repo lookup failed after 422: ${retry.status}`);
      return this.toRemote(repoName, (await retry.json()) as Record<string, unknown>);
    }
    if (!create.ok) throw new Error(`GitHub create repo failed: ${create.status} ${await create.text().catch(() => "")}`);
    return this.toRemote(repoName, (await create.json()) as Record<string, unknown>);
  }

  private toRemote(repoName: string, j: Record<string, unknown>): RemoteRepo {
    const html = (j["html_url"] as string) || this.htmlUrl(repoName);
    const clone = (j["clone_url"] as string) || `${this.cloneUrlPrefix}/${repoName}.git`;
    return { name: repoName, html_url: html, clone_url: clone, token: this.token, org: this.org };
  }
}
