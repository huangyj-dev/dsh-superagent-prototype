import { describe, expect, it } from 'vitest'
import { GitlabConfigSchema, mentions, noteTrigger, threadId, tokenOf, webBase, type GitlabNote } from '../src/sources/gitlab.ts'
import { listingOf, patternToRegExp, selectionOf } from '../src/infra/gitlab-groups.ts'

const config = GitlabConfigSchema.parse({ repository: 'gba-mwf/motor/grapes_torch', baseUrl: 'http://code.gbamwf.cn:53000/api/v4',
  tokenFile: '/home/me/.dsh/gitlab-token', botUsername: 'agent-bot' })
const item = { iid: 7, title: 'Fix the mem-debug accounting', web_url: 'http://code.gbamwf.cn:53000/gba-mwf/motor/grapes_torch/-/issues/7', updated_at: '2026-11-03T00:00:00Z' }
const note = (overrides: Partial<GitlabNote> = {}): GitlabNote => ({ id: 41, body: '@agent-bot please fix this', system: false,
  created_at: '2026-11-03T00:01:00Z', updated_at: '2026-11-03T00:01:00Z', author: { username: 'alice' }, ...overrides })

describe('GitLab notes as Triggers', () => {
  it('keeps Issues and merge requests on separate Threads and identifies a note by its own id', () => {
    const issue = noteTrigger(config, item, 'issues', note(), 'agent-bot')
    const mr = noteTrigger(config, item, 'merge_requests', note(), 'agent-bot')
    expect(issue.threads).toEqual([{ source: 'gitlab', id: 'gba-mwf/motor/grapes_torch:issue:7' }])
    expect(mr.threads).toEqual([{ source: 'gitlab', id: 'gba-mwf/motor/grapes_torch:mr:7' }])
    expect(threadId('gba-mwf/motor/grapes_torch', 'issues', 7)).toBe('gba-mwf/motor/grapes_torch:issue:7')
    // The same note read twice (for example after an overlap) produces the same id, which the Engine deduplicates.
    expect(noteTrigger(config, item, 'issues', note(), 'agent-bot').id).toBe(issue.id)
    // An edit carries a new updated_at and so a new Trigger id.
    expect(noteTrigger(config, item, 'issues', note({ updated_at: '2026-11-03T00:05:00Z' }), 'agent-bot').id).not.toBe(issue.id)
  })

  it('marks a mention as addressed and links the reply to the note', () => {
    const trigger = noteTrigger(config, item, 'issues', note(), 'agent-bot')
    expect(trigger.addressed).toBe('mention')
    expect(trigger.human).toBe(true)
    expect(trigger.channel).toEqual({ source: 'gitlab', thread: 'gitlab:gba-mwf/motor/grapes_torch:issue:7',
      address: { project: 'gba-mwf/motor/grapes_torch', kind: 'issues', iid: '7', url: `${item.web_url}#note_41` } })
    expect(trigger.url).toBe(`${item.web_url}#note_41`)
    expect(trigger.meta).toEqual({ project: 'gba-mwf/motor/grapes_torch', kind: 'issues', iid: 7, noteId: 41, isMr: false, title: item.title })
  })

  it('does not treat a longer handle, an email or another account as a mention', () => {
    const text = 'mail bob@agent-bot.example and @agent-bot2, not @agent-bot.'
    expect(mentions(text, 'agent-bot')).toBe(true)
    expect(mentions('@agent-bot2 says hi', 'agent-bot')).toBe(false)
    expect(mentions('bob@agent-bot.example', 'agent-bot')).toBe(false)
    expect(mentions('@agent-bot', 'agent-bot')).toBe(true)
  })

  it('reads the token from the operator file and fails clearly when it is missing', () => {
    expect(() => tokenOf(GitlabConfigSchema.parse({ ...config, tokenFile: '' }))).toThrow('names no token file')
    expect(() => tokenOf(GitlabConfigSchema.parse({ ...config, tokenFile: '/nonexistent/gitlab-token' }))).toThrow('cannot be read')
  })

  it('derives the web base from the API base so links work on a self-hosted instance', () => {
    expect(webBase('http://code.gbamwf.cn:53000/api/v4')).toBe('http://code.gbamwf.cn:53000')
    expect(webBase('https://gitlab.com/api/v4/')).toBe('https://gitlab.com')
  })
})

describe('project selection', () => {
  it('folds the legacy project into the list and keeps patterns apart', () => {
    expect(selectionOf({ repository: 'a/b', projects: ['c/d', 'g/*', 'c/d'], groups: ['g', 'g'] }))
      .toEqual({ projects: ['a/b', 'c/d', 'g/*'], groups: ['g'] })
  })
  it('accepts the panel rows shape as well as a bare string', () => {
    const parsed = GitlabConfigSchema.parse({ projects: [{ path: 'g/*' }], groups: [{ path: 'team' }] })
    expect(selectionOf(parsed)).toEqual({ projects: ['g/*'], groups: ['team'] })
    expect(selectionOf({ projects: ['a/b'], groups: [] })).toEqual({ projects: ['a/b'], groups: [] })
  })
  it('accepts the blank row the Add button inserts and leaves it out of the selection', () => {
    const parsed = GitlabConfigSchema.parse({ projects: [{ path: '' }, { path: 'gba-mwf/motor/grapes_si' }], groups: [{ path: '' }] })
    expect(selectionOf(parsed)).toEqual({ projects: ['gba-mwf/motor/grapes_si'], groups: [] })
  })
  it('compiles patterns so * stops at a segment and ** does not', () => {
    expect(patternToRegExp('g/*').test('g/a')).toBe(true)
    expect(patternToRegExp('g/*').test('g/a/b')).toBe(false)
    expect(patternToRegExp('g/**').test('g/a/b')).toBe(true)
    expect(patternToRegExp('g/**').test('h/a')).toBe(false)
    expect(patternToRegExp('a/b').test('a/b')).toBe(true)
  })
  it('lists the group before a wildcard, recursively only when the pattern needs it', () => {
    expect(listingOf('g/*')).toEqual({ group: 'g', recursive: false })
    expect(listingOf('g/**')).toEqual({ group: 'g', recursive: true })
    expect(listingOf('a/b')).toBeUndefined()
    expect(() => listingOf('*/x')).toThrow('needs a group before its wildcard')
  })
})
