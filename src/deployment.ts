/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** GitLab Source account: API base URL, project path, and a Personal Access Token file the host can read. */
export const GitlabAccountsSchema = z.object({
  baseUrl: z.string().trim().regex(/^https?:\/\/[^\s]+$/, 'http(s) URL').default('https://gitlab.com/api/v4'),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/, 'group/project').default(''),
  tokenFile: z.string().trim().default(''),
})
export interface GitlabAccount { baseUrl: string; tokenFile: string; login: string }
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), gitlab: Object.keys(GitlabAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  /** Set when setup resolved a GitLab Source account; exactly one of `github` and `gitlab` names a login. */
  gitlab?: GitlabAccount
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

const GitlabUser = z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]+$/), id: z.number().int().positive() })
const GitlabProject = z.object({ path_with_namespace: z.string(),
  permissions: z.looseObject({ project_access: z.looseObject({ access_level: z.number().int() }).nullish(),
    group_access: z.looseObject({ access_level: z.number().int() }).nullish() }).nullish() })
/** Non-2xx GitLab API answer other than 401, which setup reports as a token problem. */
export class GitlabHttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
/** GitLab "Developer" access level; lower levels may read a project but cannot push to an unprotected branch. */
export const GITLAB_WRITE_LEVEL = 30
async function gitlabGet<T>(url: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response
  try { response = await fetch(url, { headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }) }
  catch (error) { throw new SetupError('gitlabUnreachable', { url, output: reason(error) }) }
  if (response.status === 401) throw new SetupError('gitlabTokenInvalid', { url })
  if (!response.ok) throw new GitlabHttpError(response.status, `${response.status} ${response.statusText}`)
  return schema.parse(await response.json())
}
/**
 * Verify a GitLab Source account: read the token file, identify the token's user, read the project, and require push access.
 * A GitLab Source needs no CLI: the account is an HTTP token, so setup resolves it directly instead of probing a command.
 */
export async function resolveGitlab(machine: Machine, gitlab: unknown): Promise<Deployment> {
  const accounts = GitlabAccountsSchema.parse(gitlab ?? {})
  const baseUrl = accounts.baseUrl.replace(/\/+$/, '')
  if (!accounts.repository) throw new SetupError('gitlabRepositoryUnset')
  if (!accounts.tokenFile) throw new SetupError('gitlabTokenUnset')
  let token: string
  try { token = readFileSync(accounts.tokenFile, 'utf8').trim() } catch (error) { throw new SetupError('gitlabTokenUnreadable', { file: accounts.tokenFile, output: reason(error) }) }
  if (!token) throw new SetupError('gitlabTokenUnreadable', { file: accounts.tokenFile, output: 'The token file is empty.' })
  const user = await gitlabGet(`${baseUrl}/user`, token, GitlabUser)
  const project = await gitlabGet(`${baseUrl}/projects/${encodeURIComponent(accounts.repository)}`, token, GitlabProject)
    .catch((error: unknown) => {
      if (error instanceof GitlabHttpError && (error.status === 403 || error.status === 404)) {
        throw new SetupError('gitlabProjectUnreadable', { account: user.username, repository: accounts.repository })
      }
      throw error
    })
  const level = project.permissions?.project_access?.access_level ?? project.permissions?.group_access?.access_level ?? 0
  if (level < GITLAB_WRITE_LEVEL) throw new SetupError('gitlabReadOnly', { account: user.username, repository: project.path_with_namespace })
  return { ...machine, repository: project.path_with_namespace, github: { cli: '', login: '', noreply: '' },
    gitlab: { baseUrl, tokenFile: accounts.tokenFile, login: user.username } }
}
