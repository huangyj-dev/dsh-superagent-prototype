# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository or one GitLab project, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub or GitLab and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Quick start with GitLab

A GitLab Source needs no `gh`: the agent acts with a Personal Access Token, and workers push branches with the same token through a git credential helper. The GitHub path in [SETUP.md](SETUP.md) and [docs/006-deployment.md](docs/006-deployment.md) is unchanged.

**1. Install.** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux and Python 3.8+, and DeepSeek Harness on `PATH` (see [docs/006-deployment.md](docs/006-deployment.md) for the supported version):

```sh
git clone https://github.com/huangyj-dev/dsh-superagent-prototype.git dsh-superagent
cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null   # create the profile once
dsh plugin --profile superagent add "link:$PWD"
```

**2. Configure the profile.** Replace `~/.dsh/profiles/superagent/cordis.patch.yml` with this, using an absolute state directory:

```yaml
- id: webserver
  config: { host: 127.0.0.1, port: 3082 }
- id: dsh-superagent
  config: { stateDir: /home/me/.dsh/state/superagent }
```

**3. Create the token file.** On the GitLab instance, create a Personal Access Token with the `api` scope for the account the agent should act as, then:

```sh
read -rsp 'GitLab PAT: ' T && mkdir -p ~/.dsh \
  && printf '%s' "$T" > ~/.dsh/gitlab-token && chmod 600 ~/.dsh/gitlab-token && unset T
```

**4. Start and open the panel.**

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

Open the URL printed in the newest `.artifacts/dsh-superagent-*.log` (the line starting with `dsh web:`), then choose **Superagent** in the sidebar. The URL carries a per-process token; after one successful open the browser keeps a cookie, and a restart prints a new URL.

**5. Configure it in the panel.**

| Group | What to set |
|---|---|
| Sources → GitLab | Project `group/project`, API base URL (`https://gitlab.example.com/api/v4`), and the token file path |
| Policy → On GitLab | The GitLab usernames allowed to originate work |
| Execution | Directory root, and a prepare command that gives each Ticket a checkout, for example `git clone --depth 1 <project url> "$DSH_SUPERAGENT_DIR" && git -C "$DSH_SUPERAGENT_DIR" config user.name "..." && git -C "$DSH_SUPERAGENT_DIR" config user.email "..."` |
| Prompts | The commit author and merge policy workers follow |

**6. Ask for work.** From an allowed account, post a note on an Issue or merge request:

```text
@<agent username> please ...
```

The Source polls every 30 seconds, opens a Ticket, the worker works in its own Session and directory, and the result returns to the same discussion. Code work arrives as a merge request; a worker keeps it a draft by prefixing the title with `Draft:` (GitLab 18.2 ignores the API's `draft` field). The agent's own account is `botUsername`, defaulting to the token owner; a dedicated GitLab account with its own token is recommended, so the agent's notes are not mistaken for a person's.

**GitLab Source limits.** Triggers come from notes on Issues and merge requests (a mention, or every note with *Receive every note* on); descriptions, CI and pipeline events do not create Tickets. Threads a Ticket follows are polled too, because GitLab does not always bump an Issue's `updated_at` when a note is added. Workers never merge: a person reviews and merges. Rotate the token by replacing the file's content; the agent and workers read it when they use it.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
