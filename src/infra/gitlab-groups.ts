/**
 * GitLab project selection shared by deployment setup and the GitLab Source: exact projects, wildcard patterns such as
 * `group/*` (direct children) and `group/**` (subgroups too), plus whole groups, expanded through the API and deduplicated.
 */
import { z } from 'zod'

const API_TIMEOUT_MS = 30_000
const ProjectSchema = z.looseObject({ path_with_namespace: z.string() })
export interface GitlabSelection { projects: string[]; groups: string[] }
/** A configured entry: rows fields submit `{ path }`, while an API save or an older config may hold the bare string. */
export type GitlabEntry = string | { path: string }
/** Accept both shapes for one pattern schema, so the panel rows and a direct API save validate the same way. */
export const entrySchema = <T extends z.ZodTypeAny>(pattern: T) => z.union([pattern, z.looseObject({ path: pattern })])
export const entryPath = (entry: GitlabEntry): string => typeof entry === 'string' ? entry : entry.path
/** Thrown when GitLab refuses a group listing; callers turn it into their own setup or health error. */
export class GitlabGroupError extends Error {
  constructor(readonly status: number, readonly group: string) { super(`GitLab group ${group} returned ${status}`) }
}
/** The configured selection: the legacy single `repository` folds into `projects`, and blanks are dropped. */
export function selectionOf(config: { repository?: string | undefined; projects?: readonly GitlabEntry[] | undefined; groups?: readonly GitlabEntry[] | undefined }): GitlabSelection {
  const legacy = config.repository?.trim()
  const projects = [...legacy ? [legacy] : [], ...(config.projects ?? []).map(entryPath)].map(project => project.trim()).filter(Boolean)
  const groups = (config.groups ?? []).map(entryPath).map(group => group.trim()).filter(Boolean)
  return { projects: [...new Set(projects)], groups: [...new Set(groups)] }
}
export const hasWildcard = (pattern: string): boolean => /[*?]/.test(pattern)
/** Compiles a project pattern: `**` spans path segments, `*` and `?` do not. */
export function patternToRegExp(pattern: string): RegExp {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') { out += '.*'; index += 1 } else out += '[^/]*'
    } else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}
/** The group a pattern lists, and whether its listing must include subgroups. */
export function listingOf(pattern: string): { group: string; recursive: boolean } | undefined {
  if (!hasWildcard(pattern)) return undefined
  const segments = pattern.split('/')
  const first = segments.findIndex(segment => hasWildcard(segment))
  if (first <= 0) throw new Error(`The pattern ${pattern} needs a group before its wildcard, such as group/*`)
  return { group: segments.slice(0, first).join('/'), recursive: pattern.includes('**') || first < segments.length - 1 }
}
async function groupPage(baseUrl: string, token: string, group: string, recursive: boolean, page: number, signal?: AbortSignal): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/groups/${encodeURIComponent(group)}/projects?include_subgroups=${recursive}&archived=false&simple=true&per_page=100&page=${page}`
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
  const response = await fetch(url, { headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new GitlabGroupError(response.status, group)
  return z.array(ProjectSchema).parse(await response.json()).map(project => project.path_with_namespace)
}
/** Every non-archived project of a group, subgroups included. */
export async function groupProjects(baseUrl: string, token: string, groups: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const found: string[] = []
  for (const group of groups) {
    for (let page = 1; page <= 50; page += 1) {
      const chunk = await groupPage(baseUrl, token, group, true, page, signal)
      found.push(...chunk)
      if (chunk.length < 100) break
    }
  }
  return found
}
/** The projects a Source watches: exact entries plus the matches of wildcard patterns and groups, without duplicates. */
export async function selectedProjects(baseUrl: string, token: string, selection: GitlabSelection, signal?: AbortSignal): Promise<string[]> {
  const exact = selection.projects.filter(project => !hasWildcard(project))
  const patterns = selection.projects.filter(hasWildcard).map(pattern => ({ pattern, matcher: patternToRegExp(pattern), listing: listingOf(pattern)! }))
  const wanted = new Map<string, { group: string; recursive: boolean }>()
  for (const group of selection.groups) wanted.set(`${group}|true`, { group, recursive: true })
  for (const { listing } of patterns) wanted.set(`${listing.group}|${listing.recursive}`, listing)
  const listed = new Map<string, string[]>()
  for (const [key, listing] of wanted) {
    if (listed.has(key)) continue
    const projects: string[] = []
    for (let page = 1; page <= 50; page += 1) {
      const chunk = await groupPage(baseUrl, token, listing.group, listing.recursive, page, signal)
      projects.push(...chunk)
      if (chunk.length < 100) break
    }
    listed.set(key, projects)
  }
  const grouped = selection.groups.flatMap(group => listed.get(`${group}|true`) ?? [])
  const matched = patterns.flatMap(({ matcher, listing }) => (listed.get(`${listing.group}|${listing.recursive}`) ?? []).filter(project => matcher.test(project)))
  // Exact entries keep their order, then whole groups, then pattern matches, all deduplicated.
  return [...new Set([...exact, ...grouped, ...matched])]
}
