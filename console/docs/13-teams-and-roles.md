# Teams and roles

This page is for anyone working in a team on Vennir: what the **Teams** page and a team's page show, what a member, a maintainer and an admin may each do, how you join a team or get access to another team's work, how single sign-on groups can decide who is in a team, and what retiring and purging a team mean. For the short version of the roles, see [Members and maintainers](01-getting-started.md#members-and-maintainers) in the walkthrough; this page goes into more detail without changing any of it.

## What is a team?

A team is a group of people, its products, and its secrets. It is also a Kubernetes namespace with the same name: every step a team's products run starts in that namespace. A team's name uses lowercase letters, digits and dashes, at most 58 of them, and never ends in `-apis`: beside its namespace each team has `<team>-apis`, where its API backends run. Once a team is purged, its name can never be used again.

A team is made in one of two ways:

- **From the catalog.** A pull request that adds `teams/<team>/team.yaml` to the catalog repository creates the team when the next catalog release is applied. The team's Settings tab says "Made by: The catalog".
- **By an admin.** An admin clicks **Create team** on the **Teams** page. Its Settings tab says "Made here". The catalog leaves a team like this alone until an admin adopts it ([admin settings](16-admin-settings.md#catalog)).

A new team has nobody in it. Whoever creates it doesn't become a member. An admin adds its first person.

## What do the Teams page and a team's page show?

**Teams** lists the teams you're in, one card each: your role, how many people it has, what's running, its secrets and bots (or schedules), what it offers, and what needs it (steps waiting for its approval, secrets that don't sync). Below them, **Who can do what** and **Joining a team** explain the roles and how people get in. An admin also sees **Create a team** and **Every other team**: each other team's state, owner in the catalog, people and what's running, with **Adopt…** for a team the catalog can take over and **Restore or purge** for a retired one. If you're in no team yet, the page says so and tells you who to ask.

Click a team to open its page. The header shows the team's name, its namespace, whether it came from the catalog, and your role there: "You maintain it", "You're a member" or "Viewing as admin". A retired team shows a **Retired** pill. A team that requires single sign-on shows "<provider> sign-in only".

A team's page has these tabs. The tab you're on is part of the address (`?tab=secrets`), so you can share a link to it.

| Tab | What it shows | Who can change it |
| --- | --- | --- |
| **Members** | Everyone in the team, their role, how they sign in, and when they were added; for an admin, which single sign-on groups put people in it | Maintainers and admins |
| **What it offers** | The team's templates, actions and APIs, as other people see them | Nobody here: it comes from the catalog |
| **Secrets** | The team's secrets: names, where each comes from, and its status. Values are never shown | Maintainers and admins |
| **Automation** | The team's bots, for its own pipelines (only maintainers and admins see this tab) | Maintainers and admins |
| **Schedules** | Runs the team starts on a timetable, each as one of its bots | Maintainers and admins |
| **APIs** | The team's API products, published through the gateway | Nobody here: it comes from the catalog |
| **Running now** | The team's steps in the cluster right now, including ones that can't start and why | Nobody: it's a live view |
| **Settings** | Sign-in, resource limits, chat notifications, the outcome webhook, where the team came from, and (for admins) retiring and purging | See [team settings](#what-are-a-teams-settings) |

Members see every tab except **Automation**, read-only. The counts on the tabs show how many there are.

## What may a member, a maintainer and an admin do?

Everyone in a team is either a member or a maintainer. An admin of the install isn't a team role. Admins can see and manage every team, whether or not they're in it.

| | Member | Maintainer | Admin |
| --- | --- | --- | --- |
| See the team's runs, outputs, logs, Pods and secrets' names | Yes | Yes | Yes, for every team |
| Run templates and actions shared with the team | Yes | Yes | Yes |
| Retry, cancel and run again a template run they started | Yes | Yes | Yes |
| Submit a raw DAG | No | Yes, if they maintain every team it names | Yes |
| Retry, cancel or run again any other run | No | Yes, if they maintain every team in it | Yes |
| Add, change or remove secrets | No | Yes | Yes |
| Add people, change roles, remove people | No | Yes | Yes |
| Add or revoke bots, manage schedules | No | Yes | Yes |
| Set the team's chat notifications and outcome webhook | No | Yes | Yes |
| Approve or decline a step awaiting approval | No | Yes, unless they submitted the run | Yes, unless they submitted the run |
| Require single sign-on, set resource limits | No | No | Yes |
| Create, retire, restore or purge a team | No | No | Yes |

A member who tries something only a maintainer may do gets: `Managing team "team-a" takes a maintainer; you're a member, not a maintainer`. Someone outside the team gets `Not a member of team "team-a", and not a platform admin.`

Membership is checked on every request, so a change takes effect immediately. Once you're removed from a team you stop seeing its runs, even ones you submitted. Template runs you started stay visible to you.

## How do I add someone, or change their role?

On the team's **Members** tab, a maintainer uses **Add a person**:

1. Type **Their console email**. They need a console account first. If they don't have one, ask an admin to create it ([People](16-admin-settings.md#people)).
2. Choose the **Role**: **Member** or **Maintainer**.
3. Click **Add to <team>**.

To change someone's role, pick it from the list next to their name. To remove someone, click **Remove**. They lose access straight away.

Two rules keep a team manageable:

- **A team always keeps a maintainer.** You can't remove or demote the last person who maintains the team (`LAST_MAINTAINER`). Make someone else a maintainer first. Bots don't count as maintainers.
- **Group-mapped teams follow their groups.** If an admin has mapped a single sign-on group to the team, you can't change the membership of someone who signs in with single sign-on (`TEAM_FOLLOWS_SSO_GROUPS`). Change their groups at your identity provider instead, or ask an admin to change the mapping ([single sign-on](#how-do-single-sign-on-groups-decide-who-is-in-a-team)). Their role says **Set by their group** and which groups give it, as their last sign-in found them.

Bots are listed on the **Automation** tab, not on **Members**.

## How do I join a team?

You can't add yourself to a team. Ask:

- **a maintainer of the team**, who can add you on its **Members** tab; or
- **an admin**, who can add you to any team. An admin who creates your account can put you straight into teams. An account created that way starts as a maintainer of each team chosen, so a new team's first person can manage it. Its maintainers can change that afterwards.

If you sign in with single sign-on for the first time, you get an account in no team. Ask a maintainer to add you, unless your groups already map you into teams.

If you don't know who maintains a team, open its page. The **Asking <team>** card shows its contact details.

## Who can see another team's page, and what is shared?

Anyone signed in can open the page of a team they're not in, at `/teams/<team>`. Instead of tabs, it shows:

- **Asking <team>**: how many people it has, who owns it in the catalog, how to contact it, its chat channel and help page. These come from the team's `team.yaml` (`owner`, `contact`, `help.chat`, `help.url`). If the team set none of them, the card says so; an admin can tell you who's in it.
- **Templates** and **Actions**: what the team offers. Each one shows whether you can use it:
  - **Run** means it's shared with you, so you can run it from the catalog.
  - **Ask for access ↗** opens a pre-filled issue in the catalog repository, asking the team to add yours to the item's `shareWith`.
  - **Not shared with you** means there's no way to ask from here.
  - A readiness pill shows whether the product is ready on this install. **Deprecated** means the team is retiring it; hover for why.
- **APIs**: the team's API products, if it has any.

Team members see the same content on their own team's **What it offers** tab.

The owning team decides who can run its templates and actions, using each one's `shareWith` in the catalog:

- `"*"` shares it with everyone signed in.
- A list of teams shares it with members of those teams. They run it *on behalf of* one of their teams. If you're in more than one of them, you choose which team.
- The owning team's own members and admins can always run it.

When you run another team's template, the run belongs to you and to the teams whose steps it runs. You can see, cancel, retry and run it again. On another team's step you see only the lines it logs at info level ([logs](09-runs-explained.md#where-are-a-steps-logs-and-why-dont-i-see-all-of-them)). Being able to run a team's template gives you no access to its secrets, members or settings.

## How do single sign-on groups decide who is in a team?

An install can let people sign in with an OpenID Connect provider (Google, Entra ID, Okta, Keycloak and others). Passwords keep working alongside it. An admin sets it up under [Single sign-on and groups](16-admin-settings.md#single-sign-on-and-groups).

An admin can also map a group to a team, with a role. For example, `platform-eng@example.com` maps to `team-a` as maintainer. Each time someone signs in with single sign-on, every mapped team follows their groups:

- in a group mapped to the team, they're added, with the best role any of their groups gives;
- no longer in such a group, they're removed;
- their role changes if their groups now give a different one.

Teams with no mapping are managed by hand on **Members**. So are bots, and people who sign in with a password.

Groups come from the ID token's groups claim, from Google Workspace, or from both. When Google Workspace is the only source, the console also rereads mapped groups every hour, so leaving a group takes you out of its team within the hour. A groups claim can only be read when you sign in, so while one is set and single sign-on is on, a session in which a group gave you a team lasts an hour at most (or the install's `jwtTtl`, if that's shorter). Then the console asks you to sign in again: you go back through the provider, which usually only asks you to pick your account, your groups are read again, and you return to the page you were on. A team a group gave you counts only in a single sign-on session from the last hour, not in a password's session.

If your groups can't be read (the claim is missing, or Google's API fails), your sign-in is refused with "Your groups couldn't be read". It is never treated as "no groups", which would remove you from your teams.

## What are a team's settings?

The **Settings** tab has these sections. Members see them read-only.

| Section | What it does | Who changes it |
| --- | --- | --- |
| **Signing in** | **Require <provider> sign-in for its members**: their passwords stop working, here and at the gateway, including sessions they already have | Admins |
| **Resource limits** | How much CPU, memory and how many Pods the team's steps may use together, and the most memory one step may ask for. The cluster enforces it. Shows whether these are the install's defaults or the team's own, and beside the team's own, the install's | Admins |
| **Chat notifications** | Posts the team's notifications to a Slack, Google Chat or Teams channel through an incoming webhook | Maintainers and admins |
| **Outcome webhook** | When one of the team's runs finishes, posts its outcome as signed JSON to the team's own systems, under the install's allowed hosts | Maintainers and admins |
| **Where it comes from** | Whether the catalog made it, its owner and contact there, its namespace, and when it was created | Nobody |
| **Retire <team>** / **Restore <team>** | Under **Admins only: ending a team**. See [retiring](#what-does-retiring-a-team-do) | Admins |
| **Purge <team>** | Under **Admins only: ending a team**. See [purging](#what-does-purging-a-team-do) | Admins |

About requiring single sign-on:

- Admins are exempt. They can always use their password, in case the provider can't be reached.
- If someone is in several teams, they must use single sign-on if any of those teams requires it.
- The section warns about members who only have a password: they can't sign in until they use single sign-on.
- If single sign-on is later turned off for the install, the setting is kept but has no effect, so nobody is locked out.

A step that asks for more than the team's limits allow fails with `RESOURCES_NOT_ALLOWED`. One that would fit once the team's other steps finish waits for them ([why a step waits](09-runs-explained.md#why-is-my-step-ready-but-not-running)).

## What does retiring a team do?

Retiring is for a team that's going away. It can be undone.

- **Who:** an admin, from **Settings → Admins only: ending a team** (**Retire <team>…**). A catalog release that no longer has the team's folder retires it too.
- **What happens:**
  - The team becomes read-only. Nothing new can be run, retried, added or changed for it (`TEAM_RETIRED`).
  - Its products are unregistered, so templates that use them stop working.
  - Its namespace is relabelled `vennir/team=retired`, so the cluster starts nothing new there. Steps already running finish. Steps of its runs that hadn't started usually fail.
  - Its people keep its history: runs, outputs and logs stay visible.
- **Undoing it:** an admin clicks **Restore <team>** in the same place, or the team's folder comes back in the catalog. The team works again. Products the catalog registers come back with its next release.

For what members see while their team is retired, see [If your team is retired](01-getting-started.md#if-your-team-is-retired).

## What does purging a team do?

Purging removes a team for good. It can't be undone.

- **Who:** an admin, from **Settings → Admins only: ending a team** (**Purge <team>…**). You confirm by typing the team's name. A catalog release never purges a team.
- **When:** only for a retired team with no unfinished runs. Otherwise it's refused with `NOT_RETIRED` or `EXECUTIONS_RUNNING`. Cancel or wait for those runs, then try again.
- **What it removes:** the team's members, its secrets' grants, its products, and any bots that belonged only to this team (their tokens stop working).
- **What it keeps:**
  - The run history.
  - The name. It stays reserved forever, so a new team can't reuse it (`NAME_RESERVED`).
  - The namespace, and its API backends' namespace (`<team>-apis`), labelled retired, for a cluster administrator to delete. The console deletes them only if the install allows that (`teamNamespaces.purge` in the console chart), which is off by default.

Admins get an alert when a team is purged.

## Common refusals

| You see | Why | What to do |
| --- | --- | --- |
| You can't open your team, or it isn't on **Teams** | You're not a member | Ask a maintainer of the team, or an admin, to add you |
| `Managing team "…" takes a maintainer` | You're a member, and this needs a maintainer | Ask a maintainer to do it, or to make you one |
| `LAST_MAINTAINER` | That change would leave the team with no maintainer | Make someone else a maintainer first |
| `TEAM_FOLLOWS_SSO_GROUPS` | Their membership follows their single sign-on groups | Change their groups, or ask an admin to change the team's mapping |
| `No such user.` when adding someone | They have no console account | Ask an admin to create one |
| `TEAM_RETIRED` | The team is retired | An admin can restore it |
| `<team> signs in with <provider>: use that instead of a password.` | A team you're in requires single sign-on | Use the **Sign in with <provider>** button |

For anything else that goes wrong, see [Troubleshooting](15-troubleshooting.md).
