/**
 * GitLab Source kind: polls a project's Issues and merge requests for new notes, turns notes addressed to the agent into
 * Triggers, replies in the same discussion, and exposes the GitLab account and project to worker Sessions.
 *
 * A GitLab Source needs no CLI: the account is the HTTP token named by the token file, so setup resolves it directly.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'
import { pause, cursorAt } from './poll.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { KV } from '../kv.ts'

export const SOURCE = 'gitlab'
const API_TIMEOUT_MS = 30_000
const PAGE = 100
export type GitlabKindId = 'issues' | 'merge_requests'
const KIND_LABEL: Record<GitlabKindId, string> = { issues: 'issue', merge_requests: 'merge request' }
const KIND_PATH: Record<GitlabKindId, string> = { issues: 'issues', merge_requests: 'merge_requests' }

export const GitlabConfigSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/, 'group/project').default(''),
  baseUrl: z.string().trim().regex(/^https?:\/\/[^\s]+$/, 'http(s) URL').default('https://gitlab.com/api/v4'),
  tokenFile: z.string().trim().default(''),
  botUsername: z.string().trim().default(''),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
  observeAll: z.boolean().default(false),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>

/** GitLab user as `/user` returns it. */
const UserSchema = z.looseObject({ username: z.string(), id: z.number().int() })
/** Issue or merge request as the project list returns it. */
const ItemSchema = z.looseObject({ iid: z.number().int(), title: z.string(), web_url: z.string().nullish(), updated_at: z.string().nullish(),
  state: z.string().nullish(), author: z.looseObject({ username: z.string() }).nullish() })
type Item = z.infer<typeof ItemSchema>
/** One note (comment) on an Issue or merge request. */
export const NoteSchema = z.looseObject({ id: z.number().int(), body: z.string().nullish(), system: z.boolean().nullish(),
  created_at: z.string(), updated_at: z.string().nullish(), author: z.looseObject({ username: z.string() }),
  noteable_type: z.string().nullish(), resolvable: z.boolean().nullish() })
export type GitlabNote = z.infer<typeof NoteSchema>

/** Non-2xx answer from the GitLab API; a 403 or 404 on a reply target means the discussion is gone. */
export class GitlabApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const baseOf = (config: GitlabConfig): string => config.baseUrl.replace(/\/+$/, '')
/** Web base (the GitLab UI origin) derived from the API base, for links and note URLs. */
export const webBase = (baseUrl: string): string => baseUrl.replace(/\/api\/v4\/?$/, '')
const projectPath = (config: GitlabConfig, path: string): string => `${baseOf(config)}/projects/${encodeURIComponent(config.repository)}${path}`
/** Reads the token from the operator's file on every call, so rotating it needs no restart of the source. */
export function tokenOf(config: GitlabConfig): string {
  if (!config.tokenFile) throw new Error('The GitLab Source names no token file')
  let token: string
  try { token = readFileSync(config.tokenFile, 'utf8').trim() }
  catch (error) { throw new Error(`The GitLab token file ${config.tokenFile} cannot be read: ${String(error)}`) }
  if (!token) throw new Error(`The GitLab token file ${config.tokenFile} is empty`)
  return token
}
async function call<T>(config: GitlabConfig, path: string, schema: z.ZodType<T>, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  return callAt(projectPath(config, path), config, path, schema, signal, init)
}
/** Calls an instance-level endpoint (such as `/user`) that is not scoped to the configured project. */
async function rootCall<T>(config: GitlabConfig, path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return callAt(`${baseOf(config)}${path}`, config, path, schema, signal, {})
}
async function callAt<T>(url: string, config: GitlabConfig, path: string, schema: z.ZodType<T>, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
  const response = await fetch(url, {
    ...init,
    headers: { 'PRIVATE-TOKEN': tokenOf(config), accept: 'application/json', ...init.body ? { 'content-type': 'application/json' } : {} },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (response.status === 403 || response.status === 404) throw new GitlabApiError(response.status, `GitLab ${response.status} for ${path}`)
  if (!response.ok) throw new GitlabApiError(response.status, `GitLab ${response.status} ${response.statusText} for ${path}`)
  if (response.status === 204) return undefined as T
  return schema.parse(await response.json())
}
/** Reads every page of a list endpoint, stopping when a short page arrives. */
async function pages<T>(config: GitlabConfig, path: string, schema: z.ZodType<T>, signal?: AbortSignal, maxPages = 50): Promise<T[]> {
  const joined = path.includes('?') ? `${path}&` : `${path}?`
  const all: T[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const chunk = await call(config, `${joined}per_page=${PAGE}&page=${page}`, z.array(schema), signal)
    all.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return all
}
/** True when `text` mentions `username` as a whole handle, not as the tail of an email address or a longer name. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
/** Stable per-note Thread key inside this Source: Issues and merge requests share number sequences, so the kind is part of it. */
export const threadId = (kind: GitlabKindId, iid: number): string => `${kind === 'issues' ? 'issue' : 'mr'}:${iid}`
const noteUrl = (config: GitlabConfig, item: Item, kind: GitlabKindId, note: GitlabNote): string =>
  `${item.web_url ?? `${webBase(config.baseUrl)}/${config.repository}/-/${KIND_PATH[kind]}/${item.iid}`}#note_${note.id}`
/** GitLab reply address: one Issue or merge request conversation. */
export const gitlabChannel = (config: GitlabConfig, kind: GitlabKindId, iid: number, url: string): ChannelRef =>
  ({ source: SOURCE, thread: `gitlab:${threadId(kind, iid)}`, address: { project: config.repository, kind, iid: String(iid), url } })

/** Builds the Trigger for one note; `agent` is the username whose mentions address the agent and whose own notes are skipped. */
export function noteTrigger(config: GitlabConfig, item: Item, kind: GitlabKindId, note: GitlabNote, agent: string): Trigger {
  const body = note.body ?? ''
  const url = noteUrl(config, item, kind, note)
  return {
    id: key('gitlab-note', `${kind}:${item.iid}`, String(note.id), note.updated_at ?? ''),
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(kind, item.iid) }],
    actor: { source: SOURCE, id: note.author.username },
    // GitLab system notes (label changes, assignments) are produced by GitLab itself, never by a person.
    human: note.system !== true,
    at: note.created_at,
    text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(config, kind, item.iid, url),
    url,
    meta: { project: config.repository, kind, iid: item.iid, noteId: note.id, isMr: kind === 'merge_requests', title: item.title },
  }
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '自建或官方 GitLab 上的一个项目；接收发给智能体的 Issue 与合并请求评论，并用同一个账号回复。',
    en: 'One project on GitLab, self-hosted or not; receives Issue and merge-request notes addressed to the agent and replies as the same account.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-/]+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project（可含子组）。保存时检查令牌能否读取并推送到它，然后重启 dsh-superagent。',
        en: 'Written group/project (subgroups allowed). Saving checks that the token can read and push to it, then restarts dsh-superagent.' } },
    { key: 'baseUrl', type: 'text', label: { zh: 'API 地址', en: 'API base URL' },
      hint: { zh: '自建实例一般写作 https://gitlab.example.com/api/v4。', en: 'For a self-hosted instance, usually https://gitlab.example.com/api/v4.' } },
    { key: 'tokenFile', type: 'text', label: { zh: '令牌文件', en: 'Token file' },
      hint: { zh: '存放 Personal Access Token（api scope）的文件绝对路径。智能体用这个令牌发言，执行器用它推分支、开合并请求。令牌不进配置。',
        en: 'Absolute path of a file holding a Personal Access Token with the api scope. The agent speaks with this token, and workers push branches and open merge requests with it. The token never enters the settings.' } },
    { key: 'botUsername', type: 'text', label: { zh: '智能体的 GitLab 用户名（可选）', en: 'Agent GitLab username (optional)' },
      hint: { zh: '默认用令牌所属账号。填写别的用户名时，该账号的评论才会被当成智能体自己的消息而跳过；测试时可用。',
        en: 'Defaults to the account the token belongs to. A different name changes which notes count as the agent\'s own and are skipped; useful for testing.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeAll', type: 'switch', label: { zh: '接收项目里的全部评论', en: 'Receive every note in the project' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选；从打开的时候开始，不读以前的。',
        en: 'Notes that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on.' } },
  ],
  health: ['gitlab'],
  scope: ({ meta }, config) => ({ listened: true, observed: !!config.observeAll, row: 'comments' }),
  channel: {
    async send(host, message): Promise<'sent' | 'gone'> {
      const account = host.commands.deployment.gitlab
      if (!account) throw new Error('This installation has no GitLab account')
      const { project, kind, iid } = message.channel.address
      const config: GitlabConfig = { ...GitlabConfigSchema.parse({ repository: project, baseUrl: account.baseUrl, tokenFile: account.tokenFile }) }
      const path = `/${KIND_PATH[kind as GitlabKindId] ?? 'issues'}/${iid}/notes`
      const marker = `<!-- dsh-superagent:${message.id} -->`
      const body = `${message.text}\n\n${marker}`
      try {
        const existing = await pages(config, path, NoteSchema)
        if (existing.some(note => note.author.username === account.login && (note.body ?? '').includes(marker))) return 'sent'
        await call(config, path, z.unknown(), undefined, { method: 'POST', body: JSON.stringify({ body }) })
        return 'sent'
      } catch (error) {
        if (error instanceof GitlabApiError && (error.status === 403 || error.status === 404)) return 'gone'
        throw error
      }
    },
    link(address): { url: string; label: Localized } {
      const kind = (address.kind as GitlabKindId) ?? 'issues'
      const iid = address.iid ?? ''
      const project = address.project ?? ''
      return { url: address.url ?? '', label: { zh: `GitLab ${KIND_LABEL[kind]} ${project}${iid ? ` !${iid}` : ''}`,
        en: `GitLab ${KIND_LABEL[kind]} ${project}${iid ? ` !${iid}` : ''}` } }
    },
  },
  // `!12`, `#12`, or a note URL names the merge request or Issue 12 of the configured project.
  find: query => {
    const number = /^[#!]?(\d+)$/.exec(query.trim())?.[1]
    const url = /\/-\/(?:issues|merge_requests)\/(\d+)/.exec(query)?.[1]
    const iid = number ?? url
    return { threads: iid ? [`gitlab:issue:${iid}`, `gitlab:mr:${iid}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或合并请求的评论里 @ 智能体的用户名。', en: 'An account on the list mentions the agent\'s username in an Issue or merge-request note.' },
    rows: () => [{ id: 'comments', label: { zh: '评论', en: 'Notes' }, note: { zh: '仅 @', en: '@ only' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.noteId ?? ''),
    async read(_commands, trigger, part, cursor, config) {
      // Only the current conversation is supported; `root` and `parent` map to the same note list.
      const project = String(trigger.meta.project ?? config.repository)
      const kind = (trigger.meta.kind as GitlabKindId) ?? 'issues'
      const iid = Number(trigger.meta.iid)
      const page = Math.max(1, Number(cursor ?? '1') || 1)
      const scoped: GitlabConfig = { ...config, repository: project }
      const notes = await call(scoped, `/${KIND_PATH[kind]}/${iid}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`, z.array(NoteSchema))
      const messages = notes.map(note => ({ id: String(note.id), from: note.author.username, at: note.created_at, text: note.body ?? '',
        ...(note.system ? { bot: true as const } : {}) }))
      return { messages, ...(notes.length === 20 ? { next: String(page + 1) } : {}),
        body: { project, kind, iid, part }, status: undefined }
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_API_URL', description: { zh: 'GitLab API 基地址，例如 https://gitlab.example.com/api/v4', en: 'GitLab API base URL, such as https://gitlab.example.com/api/v4' } },
      { key: 'DSH_SUPERAGENT_GITLAB_TOKEN_FILE', description: { zh: '持有智能体访问令牌的文件；用 `curl -H "PRIVATE-TOKEN: $(cat ...)"` 调用 API', en: 'File holding the agent\'s access token; call the API with `curl -H "PRIVATE-TOKEN: $(cat ...)"`' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: '这个来源监听的项目，group/project', en: 'The project this Source watches, group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '触发工单的对象类型：issues 或 merge_requests', en: 'Kind of the object that started the ticket: issues or merge_requests' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '触发工单的 Issue 或合并请求编号；工单不是从 GitLab 来的时为空', en: 'IID of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 用户名；评论、分支和合并请求都以它出现', en: 'The agent\'s GitLab username; comments, branches and merge requests appear under it' } },
    ],
    values: ({ deployment, config, trigger }) => ({
      DSH_SUPERAGENT_GITLAB_API_URL: deployment.gitlab?.baseUrl ?? config.baseUrl,
      DSH_SUPERAGENT_GITLAB_TOKEN_FILE: deployment.gitlab?.tokenFile ?? config.tokenFile,
      DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.repository || config.repository,
      DSH_SUPERAGENT_GITLAB_KIND: trigger?.source === SOURCE ? String(trigger.meta.kind ?? '') : '',
      DSH_SUPERAGENT_GITLAB_IID: trigger?.source === SOURCE ? String(trigger.meta.iid ?? '') : '',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
    }),
  },
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the account; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    if (!config) {
      ctx.report('gitlab', health('paused', 'sourceOff'))
      await pause(60_000, signal)
      continue
    }
    try {
      await pollRound(ctx, config, signal)
      failures = 0
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config.failuresBeforeError ?? 3)) {
        ctx.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    const current = ctx.config<GitlabConfig>(SOURCE)
    await pause(Math.max(current?.pollSeconds ?? config.pollSeconds, 10) * 1000, signal)
  }
}

/** Reads the project's Issues and merge requests updated since the cursor and ingests notes newer than it. */
export async function pollRound(ctx: SourceContext, config: GitlabConfig, signal?: AbortSignal): Promise<void> {
  const since = ctx.state.get(KV.gitlab.since) ?? new Date().toISOString()
  if (ctx.state.get(KV.gitlab.since) === undefined) ctx.state.set(KV.gitlab.since, since)
  const agent = config.botUsername || (await rootCall(config, '/user', UserSchema, signal)).username
  const items: { kind: GitlabKindId; item: Item }[] = []
  for (const kind of ['issues', 'merge_requests'] as const) {
    const updated = await pages(config, `/${KIND_PATH[kind]}?state=all&order_by=updated_at&sort=asc&updated_after=${encodeURIComponent(since)}`, ItemSchema, signal)
    for (const item of updated) items.push({ kind, item })
  }
  // GitLab does not reliably bump an Issue's updated_at for a new note, so also read every Thread a Ticket follows or
  // followed; that is how a follow-up on an Issue whose timestamp stayed put still reaches its Ticket.
  for (const thread of ctx.threads.subscribed(SOURCE)) {
    const kind = thread.meta.kind as GitlabKindId | undefined
    const iid = Number(thread.meta.iid)
    if ((kind !== 'issues' && kind !== 'merge_requests') || !iid) continue
    items.push({ kind, item: { iid, title: typeof thread.meta.title === 'string' ? thread.meta.title : '', web_url: typeof thread.meta.url === 'string' ? thread.meta.url : undefined } })
  }
  let notes = 0
  const seen = new Set<string>()
  for (const { kind, item } of items) {
    if (signal?.aborted) return
    const thread = threadId(kind, item.iid)
    if (seen.has(thread)) continue
    seen.add(thread)
    const readFrom = ctx.state.get(KV.gitlab.thread(thread)) ?? since
    notes += await intakeNotes(ctx, config, kind, item, readFrom, agent, signal)
    ctx.state.set(KV.gitlab.thread(thread), cursorAt(new Date().toISOString()))
    ctx.threads.patch(`gitlab:${thread}`, { title: item.title, kind, iid: item.iid, ...item.web_url ? { url: item.web_url } : {} })
    ctx.threads.describe(`gitlab:${thread}`, { label: `${KIND_LABEL[kind]} ${config.repository}!${item.iid}: ${item.title}`,
      ...item.web_url ? { url: item.web_url } : {}, facts: { iid: { value: kind === 'merge_requests' ? `!${item.iid}` : `#${item.iid}` } } })
  }
  if (signal?.aborted) return
  ctx.state.set(KV.gitlab.since, cursorAt(new Date().toISOString()))
  ctx.report('gitlab', { state: 'ready', detail: `${seen.size} ${seen.size === 1 ? 'thread' : 'threads'} read, ${notes} new notes; next poll ≥ ${config.pollSeconds}s`,
    at: new Date().toISOString() })
}

/** Ingests the notes of one Issue or merge request newer than `since`, skipping the agent's own notes and GitLab system notes. */
async function intakeNotes(ctx: SourceContext, config: GitlabConfig, kind: GitlabKindId, item: Item, since: string, agent: string, signal?: AbortSignal): Promise<number> {
  // Newest first so one request is enough for a polling round; reversed so a batch keeps conversation order.
  const notes = (await pages(config, `/${KIND_PATH[kind]}/${item.iid}/notes?sort=desc&order_by=created_at&per_page=50`, NoteSchema, signal, 1)).reverse()
  let fresh = 0
  for (const note of notes) {
    if (signal?.aborted) return fresh
    const at = Date.parse(note.updated_at ?? note.created_at)
    if (!Number.isFinite(at) || at < Date.parse(since)) continue
    if (note.system === true || note.author.username === agent) continue
    // Skip the host's own replies even when the account that posts them is also a person's account.
    if ((note.body ?? '').includes('<!-- dsh-superagent:')) continue
    // An empty note cannot carry a request; a bodyless system note was dismissed above.
    if (!(note.body ?? '').trim()) continue
    await ctx.receive(noteTrigger(config, item, kind, note, agent))
    fresh += 1
  }
  return fresh
}
