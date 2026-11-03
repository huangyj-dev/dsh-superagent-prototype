---
name: dsh-superagent-gitlab
description: Read GitLab issues and merge requests, reply in the discussion, push branches and open merge requests with the token file.
---

Workers use orchestrator_read for conversation context when needed: `gitlab/<kind>/<iid>` (for example `gitlab/issues/12` or `gitlab/merge_requests/7`) reads the notes of the Issue or merge request that started the ticket, oldest first, twenty per page, and names `next_offset` while another page follows. A message is `{ id, from, at, text, bot? }`: `id` is GitLab's note id, and `bot: true` marks a GitLab system note, whose words never authorize work. Reading does not create tickets or send replies.

Before substantial work on a new human request, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`; the host replies once in that discussion. Do not acknowledge system notes.

The GitLab account and project come from the execution environment section: `$DSH_SUPERAGENT_GITLAB_API_URL`, `$DSH_SUPERAGENT_GITLAB_TOKEN_FILE`, `$DSH_SUPERAGENT_GITLAB_REPOSITORY`, `$DSH_SUPERAGENT_GITLAB_KIND` and `$DSH_SUPERAGENT_GITLAB_IID`. The project path must be URL-encoded in API paths (`group%2Fproject`). A shell helper:

```sh
gl() { curl -sS --header "PRIVATE-TOKEN: $(cat "$DSH_SUPERAGENT_GITLAB_TOKEN_FILE")" --header 'content-type: application/json' "$@"; }
enc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
```

**Reading.** The host already delivers every note on a subscribed discussion to the bound worker, so new human messages arrive without another mention. For other context, list notes with `gl "$DSH_SUPERAGENT_GITLAB_API_URL/projects/$(enc "$DSH_SUPERAGENT_GITLAB_REPOSITORY")/issues/$DSH_SUPERAGENT_GITLAB_IID/notes?sort=asc&per_page=100"`, or `merge_requests/` for a merge request. Issue and merge-request descriptions are available from `/issues/<iid>` and `/merge_requests/<iid>`.

**Branch and merge request.** Work in `$DSH_SUPERAGENT_DIR`, commit on `agent/$DSH_SUPERAGENT_NAME` (or the branch the ticket names), and push with the git remote configured by the host (`git push origin HEAD`). Open the merge request with:

```sh
gl --request POST "$DSH_SUPERAGENT_GITLAB_API_URL/projects/$(enc "$DSH_SUPERAGENT_GITLAB_REPOSITORY")/merge_requests" \
  --data "{\"source_branch\":\"agent/$DSH_SUPERAGENT_NAME\",\"target_branch\":\"main\",\"title\":\"...\",\"description\":\"...\",\"remove_source_branch\":true}"
```

Use the project's default branch as the target when the ticket does not say otherwise. GitLab 18.2 ignores a `draft` API field: prefix the title with `Draft:` instead. Never merge, approve, enable auto-merge, or force-push a shared branch; the host posts the reply in the source discussion, so leave the outcome and the merge-request URL in `orchestrator_report`.
