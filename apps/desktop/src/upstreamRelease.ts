// FILE: upstreamRelease.ts
// Purpose: Reads upstream release metadata without ever resolving an installer payload.
// Layer: Desktop update-notice utility

import { isUpdateVersionNewer } from "./updateState";

export const SYNARA_UPSTREAM_RELEASE_REPOSITORY = "Emanuele-web04/synara";
export const SYNARA_UPSTREAM_RELEASE_API_URL =
  "https://api.github.com/repos/Emanuele-web04/synara/releases/latest";

const DEFAULT_UPSTREAM_RELEASE_TIMEOUT_MS = 10_000;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface UpstreamRelease {
  readonly version: string;
  readonly releaseUrl: string;
}

export function isSynaraUpstreamReleaseRepository(repository: string): boolean {
  return repository.trim().toLowerCase() === SYNARA_UPSTREAM_RELEASE_REPOSITORY.toLowerCase();
}

function assertGitHubRepository(repository: string): string {
  const normalized = repository.trim();
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized)) {
    throw new Error(`Invalid upstream GitHub repository: ${repository}.`);
  }
  return normalized;
}

export function buildUpstreamReleaseApiUrl(repository = SYNARA_UPSTREAM_RELEASE_REPOSITORY): string {
  const normalized = assertGitHubRepository(repository);
  return `https://api.github.com/repos/${normalized}/releases/latest`;
}

export function buildUpstreamReleasePageUrl(
  tagName: string,
  repository = SYNARA_UPSTREAM_RELEASE_REPOSITORY,
): string {
  const normalizedRepository = assertGitHubRepository(repository);
  const normalizedTagName = tagName.trim();
  if (normalizedTagName.length === 0) {
    throw new Error("Upstream release is missing a tag name.");
  }
  return `https://github.com/${normalizedRepository}/releases/tag/${encodeURIComponent(normalizedTagName)}`;
}

function readReleaseTag(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Upstream release response is not an object.");
  }
  const tagName = (payload as Record<string, unknown>).tag_name;
  if (typeof tagName !== "string" || tagName.trim().length === 0) {
    throw new Error("Upstream release response is missing tag_name.");
  }
  return tagName.trim();
}

export function parseUpstreamRelease(
  payload: unknown,
  repository = SYNARA_UPSTREAM_RELEASE_REPOSITORY,
): UpstreamRelease {
  const version = readReleaseTag(payload);
  return {
    version,
    // Deliberately derive this from the fixed repository and tag rather than
    // accepting an artifact URL from the API response.
    releaseUrl: buildUpstreamReleasePageUrl(version, repository),
  };
}

export async function fetchLatestUpstreamRelease(input?: {
  readonly fetch?: typeof globalThis.fetch;
  readonly repository?: string;
  readonly timeoutMs?: number;
}): Promise<UpstreamRelease> {
  const repository = input?.repository ?? SYNARA_UPSTREAM_RELEASE_REPOSITORY;
  const fetchImpl = input?.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1, input?.timeoutMs ?? DEFAULT_UPSTREAM_RELEASE_TIMEOUT_MS);
  const response = await fetchImpl(buildUpstreamReleaseApiUrl(repository), {
    method: "GET",
    headers: GITHUB_API_HEADERS,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Upstream release check failed with HTTP ${response.status}.`);
  }
  return parseUpstreamRelease((await response.json()) as unknown, repository);
}

export function isUpstreamReleaseNewer(currentVersion: string, release: UpstreamRelease): boolean {
  return isUpdateVersionNewer(currentVersion, release.version);
}
