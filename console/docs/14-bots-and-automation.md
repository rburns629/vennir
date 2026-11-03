# Bots and automation

This page is for a team's maintainer who wants Vertra to work without a person at the console: a pipeline that submits DAGs or runs templates, a CI job that signs in with no stored token, another system that places orders and hears back, runs on a timetable, and notifications in chat, the console and email. It covers what to set up and where. The API calls themselves are in [Calling the API](05-calling-the-api.md).

## Which kind of bot do I need?

A bot is an account that signs in with a token instead of a password. Each kind can do a different amount, so pick the narrowest that does the job.

| You want | Use | Made on | It can |
| --- | --- | --- | --- |
| A pipeline that submits your team's DAGs, runs templates, retries | A **team bot** | Your team → **Automation → Add a bot** | What a maintainer of your team can, and nothing in any other team |
| A storefront or another system that places orders | An **ordering bot** | The same, ticking *It places orders* | Run only the templates you list for it, for your team |
| Either of those, from GitHub Actions or GitLab, with no stored secret | **Keyless sign-in** for that bot | **Add a bot → Keyless, from CI**, or an existing bot's card → **Sign in from CI…** | What the bot can, for an hour at a time |
| Platform automation of an admin's own (creating teams, registering products) | An **automation token** | **Admin → Automation tokens** (admins only) | Only the scopes ticked; never read a secret or submit a run |

Give each pipeline or system its own bot, so revoking one doesn't break the others. You don't need a bot to publish products: the catalog's own CI does that, and the console pulls the catalog itself.

## How do I add a bot and get its token?

Only a maintainer of the team sees the **Automation** tab.

1. Open your team → **Automation**, and under **Add a bot**, say **What will use it?**, for example `release pipeline in our infra repo`. The bot is named after it: `team-a-release-pipeline-in-our-infra-repo@bots.vertra.local`. Its address is only a name; nothing is ever mailed to it.
2. Pick **Expires after** ([how long](#how-long-does-a-token-last-and-how-do-i-rotate-it)).
3. **Create bot and token.**
4. **Copy it now**: the token is shown only this once. Store it as a secret where the pipeline runs, for example `gh secret set VERTRA_TOKEN --repo <your-org>/<your-repo>`. The card shows a first call to make with it.
5. **Done.**

The bot's card then lists each of its tokens: its label, when it was made, when it was last used (to within five minutes), and when it expires. Its chip says **Active** (it has a working token), **Keyless** (it signs in from CI only) or **No token** (anything still using an old token fails to sign in).

**Revoke** on a token stops it at once; any pipeline still using it fails to sign in. A maintainer of the team or an admin can revoke one.

A team bot is a maintainer of its team. So a leaked token can do what a maintainer can there: register and replace the team's secrets, submit raw DAGs, retry and cancel the team's runs, manage its people and bots. Keep it in your CI's secret store, never in a repository, and prefer [keyless sign-in](#how-do-i-sign-in-from-ci-without-a-stored-token) where your CI supports it.

## How long does a token last, and how do I rotate it?

You choose when you make it: **30 days**, **90 days** (the default), **1 year**, **2 years**, or **Until revoked**. An expired token is refused just like a revoked one, by the console and by the API gateway.

To rotate a token before it expires:

1. **Add a bot** again with exactly the same words in **What will use it?**. That gives the same bot a second token instead of a new bot.
2. Put the new token in your pipeline.
3. **Revoke** the old one on the bot's card.

The bot keeps its other tokens while you do this, so nothing breaks in between.

## How do I sign in from CI without a stored token?

A GitHub Actions or GitLab CI job can sign in as a bot with its own identity, so the pipeline holds no Vertra secret at all.

1. For a new bot: under **Add a bot**, say **What will use it?** and choose **Keyless, from CI** under **How it signs in**; the same fields follow, and **Create bot** makes the bot with no token at all, then shows the job's lines beside it. For a bot you already have: on its card, under **Signs in from CI, with no token**, choose **Sign in from CI…**.
2. Pick the **CI**, then give **Repository (owner/name)** for GitHub or **Project (group/name)** for GitLab.
3. Optionally, **Only from this branch**, such as `refs/heads/main`. Jobs on any other branch are refused.
4. **Add.** The form shows the lines to put in the job: they ask the CI for an ID token for this install, exchange it, and keep the result as `VERTRA_TOKEN`.

The exchanged token is good for an hour, as that bot. A token from any other repository or branch, or one minted for another service, is refused. The bot's card lists each CI identity with when it was last used, and **Remove** stops it.

A bot made keyless has no token to leak, and its card shows **Keyless**. A bot that started with a token keeps it: once its CI sign-in works, revoke the token, and the card shows **Keyless** too.

Which CIs you can choose is the install's setting (GitHub Actions and gitlab.com by default). When it allows neither, the section isn't shown.

The exchange itself, step by step: [Calling the API](05-calling-the-api.md#or-no-token-at-all-sign-in-from-ci).

## How do I let another system place orders?

An ordering bot is for a system that should only ever run a few published templates, such as a self-service page or an event consumer.

1. **Automation → Add a bot**, and tick **It places orders (a storefront, or another system): only the templates listed, nothing else**.
2. List **Templates it may order**: `<team>/<name>`, one per line, as the Catalog shows them.
3. **Create bot and token**, and store the token as above.

The list stays editable on the bot's card (**Edit**, then **Save**), by the team's maintainers.

An ordering bot is a member of your team, not a maintainer. It can't submit raw DAGs, run single actions, or rerun anything (`ORDERS_ONLY`), and a template not on its list is refused (`TEMPLATE_NOT_ORDERABLE`). Each order runs for your team, under your team's limits, quota and approvals.

It may place 60 orders a minute (unless your install says otherwise); past that, an order is refused with `resource_exhausted` and a `Retry-After` header. Give each order a `requestId` of its own: sending the same one again after a timeout returns the run already started instead of a second one.

The call, and what each refusal looks like: [Placing orders from another system](05-calling-the-api.md#placing-orders-from-another-system). What a leaked ordering token can do: the [security model](security-model.md#ordering-bots).

## How does a system hear back when an order finishes?

Give the ordering bot a callback, and the console posts each of its orders' outcomes there, signed, so the system doesn't have to poll.

On the bot's card, where it says `No callback: whatever placed an order asks how it went.`:

1. Enter the **URL**. It must be `https://`, under a host your install allows (an admin lists them in the console chart's `orders.callbackHosts`; none by default).
2. **Save.** The bot's signing secret is shown, once. Store it with your receiver.

From then on the card says `Posts to <host>, signed`, with when it last posted, and, if the last post failed, `The last post didn't go: ...`. The URL itself is never shown again.

When an order finishes (succeeded, failed or cancelled), the console posts an `order.finished` message: which run and order it was, the template, which team it ran for, and how it ended. It carries no outputs; read them with `GetExecution`, as the bot.

Every post carries a `Vertra-Signature: t=<unix seconds>,v1=<hex>` header, where `v1` is the HMAC-SHA256 of `<t>.<body>` with the secret. Before trusting a post, check the signature and that `t` is recent (within five minutes, say). Answer with any 2xx. Anything else, or no answer within 10 seconds, is tried again every 30 seconds, five times in all. A post can arrive twice, so act on each run's outcome once.

To change it:

- **Save** with a new URL keeps the same secret.
- **Save with a new secret** sets the URL you entered and replaces the secret. The old secret stops being used, so update your receiver.
- **Remove** stops the posts.

The message's fields and a receiver's signature check in code: [Hearing back without polling](05-calling-the-api.md#hearing-back-without-polling).

## How do I get every run's outcome posted to our systems?

A team can have an **outcome webhook**: every run the team owns posts a `run.finished` message there when it finishes, with each step's state, outputs and failure code. It's for the team's own systems, not for chat.

It's on your team's **Settings** tab, under **Outcome webhook**, and works like an ordering bot's callback: a URL under a host your install allows (**Allowed hosts** are listed there), **Save**, a signing secret shown once, signed the same way, **Save with a new secret** and **Remove**. Its maintainers set it; every member sees where it posts and whether the last post worked. When the install allows no hosts and none is set, the card isn't shown.

Unlike a bot's callback, it carries outputs, as your members see them on the run's page. Past 256 KiB the outputs are left out (`"outputsOmitted": true`); read them with `GetExecution`. So only point it where you'd show those outputs.

The message's fields: [Every run of your team, for your systems](05-calling-the-api.md#every-run-of-your-team-for-your-systems).

## How do I get my team's notifications in chat?

Your team's **Settings** tab has **Chat notifications**: it posts the team's notifications to a Slack, Google Chat or Microsoft Teams channel through its incoming webhook.

1. Create an incoming webhook in your chat tool, for the channel you want.
2. Paste it in **Webhook URL**. It must be under a host the install allows (listed under the field: Slack's, Google Chat's and Teams' by default). It's kept encrypted and never shown again; the card shows only its host.
3. Tick what to post:

   | Ticked | Posts when |
   | --- | --- |
   | **A run for the team failed** | A run of the team's fails |
   | **A step waits for the team's approval** | One of the team's steps is awaiting approval |
   | **A product of the team isn't ready on this install** | A product's readiness check finds something missing |
   | **The cluster refused a step of the team** | An unsigned or unallowed image, say |

4. **Save**, then **Send a test**.

Only maintainers set, test and remove it; members see whether it's set and when it last posted. A post says what happened and links to the console. It never carries outputs or logs. A run that succeeded isn't posted: that stays in the person's own bell.

An admin can make one team's chat webhook the admins' channel (**Admin → Admins' alerts**). That team's form then also offers the admins' alerts: platform changes and faults, and the catalog not being pulled.

## What lands in the notification bell, and can I get it by email?

The bell (in the sidebar, next to your name) shows your own notifications, with how many are unread. Opening one marks it read and takes you to what it's about; **Mark all read** clears the count. It's looked at again every minute.

| Notification | Who gets it |
| --- | --- |
| A run failed | Whoever ran it |
| A run finished | Whoever ran it |
| A step waits for approval | The maintainers of the step's team (not whoever ran it, who can't decide) |
| A product isn't ready here | Its team's maintainers, and admins |
| The cluster refused a step | Whoever ran it, and admins |
| The catalog isn't being pulled; a team purged, image sources changed, a policy not syncing, the audit log's copy stopped or its chain broken | Admins |

Nobody sees anyone else's notifications.

When your install sends email, **Settings → Preferences** has an **Email** card: tick which kinds also come by email, to your account's address. Like chat posts, emails say what happened and link to the console, with no outputs or logs. Without email set up, the card isn't shown.

## How do I run something on a schedule?

A schedule runs a template or action on a timetable, with set inputs, for your team, as one of its bots. Make one from the run form's **Schedule…** button, which a team's maintainers see: [the steps are here](10-ordering-and-the-cart.md#how-do-i-run-something-on-a-schedule).

What a maintainer should know:

- **It runs as the bot, never as you.** Each run gets the bot's access as it is then, through the same checks as the bot running it itself: sharing, the inputs' schema, targets, and approvals. So pick a bot that may run it. An ordering bot may run only the templates on its list.
- **A refused start is kept.** If the bot loses access, or the inputs no longer fit the template, that start is refused, shown in the **Schedules** tab's **Last** column, and told to the team's maintainers. The schedule stays on, and tries again next time.
- **A schedule that can't run again says so.** If its timetable or time zone stops reading (a time zone the console no longer knows, say), it runs that once, then stops, with the reason in **Last** and told to the maintainers. **Edit** its timetable to start it again.
- **At most every five minutes**, in the time zone you give.
- **Times missed while the console was down** start once, for the latest time missed, not once for each.
- **Deleting the bot deletes its schedules.** Revoking its token doesn't: the schedule doesn't use a token.
- An ordering bot's rate limit doesn't apply to its schedules' runs: the schedule is your team's, made by its maintainers.

On the **Schedules** tab, **On** pauses and resumes one, **Edit** changes it, and **Delete** removes it; the runs it started stay. **Edit** changes **When**, the time zone and **Runs as**; **Change inputs…** opens the run form filled in with its inputs, and **Save to schedule** keeps the new ones. What it runs doesn't change: for something else, make another schedule. Saving a schedule that's on checks that its bot may run it with those inputs, as its next start would; a paused one is checked when it's turned back on. A run it already started finishes as it began. Maintainers can also **Edit** from **Runs → Schedules**.

## What are automation tokens, for admins?

An admin's automation token belongs to no team, and does only what its scopes allow. It's for automation of the platform itself, not for running things. The catalog needs none: the console reads the catalog's release itself.

On **Admin → Automation tokens**, give a **Label**, tick its scopes, pick **Expires after**, and **Create token**. It's shown once.

| Scope | Lets it |
| --- | --- |
| `teams:create` | Create teams and their namespaces |
| `products:register` | Register and update any team's products |
| `teams:retire` | Retire or un-retire a team (reversible) |
| `teams:delete` | Purge a retired team for good. Give this to a token of its own |
| `secret-stores:apply` | Apply a team's reviewed SecretStore file |

Whatever it's given, it can't read a secret, submit a run, or create other tokens. **Revoke** stops it at once.

## Where to look next

- [Calling the API](05-calling-the-api.md): every call a bot makes, waiting for a run, reading logs, and the errors.
- [Finding and running things from the catalog](10-ordering-and-the-cart.md): what a bot runs, seen from the console.
- [Runs, explained](09-runs-explained.md): what a run's states and failure codes mean.
- The security model's [bot tokens](security-model.md#bot-tokens), [keyless bots](security-model.md#keyless-bots), [ordering bots](security-model.md#ordering-bots), [schedules](security-model.md#schedules) and [notifications](security-model.md#notifications-and-chat-webhooks): what each is allowed, and what a leak would expose.
