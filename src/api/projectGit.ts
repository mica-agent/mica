// Frontend API client for per-project git operations

const API_BASE = import.meta.env.VITE_MICA_API || "";

function gitUrl(projectId: string, path: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/git/${path}`;
}

export interface GitStatus {
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export interface GitBranchInfo {
  current: string;
  branches: string[];
}

export async function fetchGitStatus(projectId: string): Promise<GitStatus> {
  const res = await fetch(gitUrl(projectId, "status"));
  if (!res.ok) throw new Error(`Failed to fetch git status: ${res.statusText}`);
  return res.json();
}

export async function commitChanges(
  projectId: string,
  message: string
): Promise<GitCommitResult> {
  const res = await fetch(gitUrl(projectId, "commit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Failed to commit: ${res.statusText}`);
  return res.json();
}

export async function fetchGitLog(
  projectId: string,
  limit: number = 50
): Promise<GitLogEntry[]> {
  const res = await fetch(gitUrl(projectId, `log?limit=${limit}`));
  if (!res.ok) throw new Error(`Failed to fetch git log: ${res.statusText}`);
  return res.json();
}

export async function fetchGitDiff(
  projectId: string,
  ref?: string
): Promise<string> {
  const url = ref
    ? gitUrl(projectId, `diff?ref=${encodeURIComponent(ref)}`)
    : gitUrl(projectId, "diff");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch git diff: ${res.statusText}`);
  const data = await res.json();
  return data.diff;
}

export async function fetchBranches(projectId: string): Promise<GitBranchInfo> {
  const res = await fetch(gitUrl(projectId, "branches"));
  if (!res.ok) throw new Error(`Failed to fetch branches: ${res.statusText}`);
  return res.json();
}

export async function checkoutBranch(
  projectId: string,
  branch: string,
  create: boolean = false
): Promise<void> {
  const res = await fetch(gitUrl(projectId, "checkout"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, create }),
  });
  if (!res.ok) throw new Error(`Failed to checkout branch: ${res.statusText}`);
}
