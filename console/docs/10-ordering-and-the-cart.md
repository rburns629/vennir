# Finding and running things from the catalog

This page is for a team member who wants to use what other teams publish: finding a template or action in the **Catalog**, checking it's ready on this install, running it from its form, ordering several actions together with the cart, composing your own template, previewing and approving before anything changes, running it on a schedule, and finding and deleting what a run made. You don't need to write a DAG or know how products are built.

## What's in the Catalog?

**Catalog** in the sidebar lists what teams publish from their catalog repository: templates (several steps, one form) and actions (one step of one product). Each card shows its team, whether it's a template (and how many steps) or an action, its description, and the inputs it asks for (`in name, region`).

What you can run comes first. The rest is listed too, so you know it exists:

| The card says | Means | What you can do |
| --- | --- | --- |
| **Ready** (green) | It's shared with you, and its readiness check says it's ready here | **Run**, and for an action **Add to cart** |
| **No check** | It's shared with you, and nothing in it has a readiness check | **Run**, and for an action **Add to cart** |
| **Not ready**, **Check failed**, **Checking**, **Not checked yet** | It's shared with you, and its product has a readiness check ([what they mean](#what-does-not-ready-mean-on-a-product)) | Run it anyway; it may fail |
| **Deprecated** | Its team wants you to use something else; hover for what | It still runs |
| **Not shared with you** | Its team hasn't shared it with any of your teams | **Ask for access ↗** |
| **For aws installs** (under **For other installs**, last) | Its team made it for installs on another cloud than this one's | Nothing here: it isn't checked or run on this install. Run it on an install on its cloud |

**Ask for access ↗** opens a new issue on the catalog repository, filled in, in your own browser, asking the owning team to share it with yours. The console never writes to the catalog itself. Something a team marked hidden never appears here at all.

To narrow the list, type in **Search templates, actions, teams**, pick a team (**All teams** clears it), or tick **Only what I can run** or **Ready on** this install.

**Your cart** sits beside the list: the team it's for, what's in it (remove one with its ×), and how it plans (how many steps, what it adds, what you'll need to choose). **Plan and order** opens the cart; **Or build a template from it in Compose** starts Compose from it. An action already in it says **In your cart**.

Three buttons at the top lead elsewhere:

- **Every product**: every team's products by team, with how many are ready here, filters (**Not ready**, **Deprecated**, **Shared with my teams**, **Released this week**), and a row per product. Open a row for its check, its releases (every image it has been registered with, the current one marked **Latest**, each with **Copy image reference**) and, for an action shared with you, **Run on its own** and **Add to cart**.
- **Compose**: build a template yourself ([below](#how-do-i-compose-a-template-by-hand)).
- **Cart**: what you've added to order together ([below](#how-do-i-order-several-actions-together-with-the-cart)); it shows how many are in it.

## What does "Not ready" mean on a product?

A product can ship a check: an action that asks the cloud or service it works with who it is there and whether it may do its job, and changes nothing. Each install runs it on its own, as the product's identity with its secrets: when the product is registered, when its image changes, once a day, and when its team asks. So a product can be ready on one install and not on another.

| Pill | Means |
| --- | --- |
| **Ready** | The check passed on this install |
| **Not ready** | The check ran and said something is missing here, such as a permission on a folder |
| **Check failed** | The check couldn't say either way |
| **Checking** | A check is running now |
| **Not checked yet** | It hasn't been checked on this install yet |

Hover the pill to see who it acts as (`Acts as ...`) and what's missing (`Missing: ...`). A template's readiness is its steps' together: the worst of them, with everything any of them lacks.

Not ready doesn't stop you running it. The run form warns you (`... says it isn't ready on this install: missing ...`), and a run may fail until the owning team fixes it. Tell them: their maintainers have already been notified, once for each image and set of what's missing.

On **Every product**, open a product for the full answer: when it was checked, a link to **The check run**, and, for its own team's members and admins, **Check now**. A product with no check shows no readiness pill there; in the Catalog it shows plain **Ready**.

## How do I run a template or an action?

Choose **Run** on its card. The form has everything you choose; nothing else is yours to choose.

1. **Inputs.** Fill in the fields. They come from the template's or action's schema: required fields, choices, patterns and limits are checked on the field before anything is sent. When an input names a target (a cloud project, folder, account or subscription another team's product acts on), you see only the values its team lets your team use, or a note that it hasn't allowed any yet.
2. **Run for.** When it's shared with specific teams, pick which of yours this run is for. Otherwise it's optional, and **Just me** runs it for nobody's team.
3. **Run.** It opens the run's page.

Next to the form:

- **What will run** lists each step: which team's product, as its own identity.
- **Examples** (when its team gave some) fills the form with known-good inputs: **Use this**.
- **Good to know**: the owning team sets which identity and secrets each step uses. You can't change them, and you never see their values.
- **From a pipeline**: **Show as an API call** gives the same run as a `curl` command, for a bot ([Calling the API](05-calling-the-api.md#or-run-a-template)).

A refusal comes back on the form: an input that doesn't fit its schema on its field, anything else (a target your team may not use, a retired team) above the buttons. Nothing has run.

The run is yours to follow, cancel, retry and run again from **Runs**, as is any run you started ([Runs, explained](09-runs-explained.md)). On the run's page, **Run with changes** opens this form filled in with what it was given.

## Can I see what a run would change before it runs?

Yes, when its product has a plan: an action that says what the real one would do, without doing it. Then the form shows **Preview** next to **Run**.

**Preview** runs the plan with your inputs, as a run of its own, and shows **What it would do** under the form: for each step, a summary and each change it expects, marked **create**, **update**, **delete** or **none**, with the type and id of what it touches. A step whose plan failed says `It couldn't say: ...`. **The preview run** opens that run.

For a template, only steps that have a plan and whose inputs are known before anything runs are previewed. A step that takes an earlier step's output can't be, and is listed as `not previewed`, with why.

A preview changes nothing, but it is a run, checked like one: the action or template must be shared with you, and your inputs must fit.

## Why is my run waiting for an approval?

A product's team can make its steps wait for one of their maintainers before they run:

- always;
- only when another team runs them (so your runs of their product wait, and theirs don't);
- only when certain teams run them;
- or when a step aims at a target their team lets yours use only with an approval.

The step shows **Awaiting approval** and nothing runs until someone decides. The run's page says `Waiting for an approval from a maintainer of its team, since ...`.

Who decides is a maintainer of the step's team, which is the team whose product it is, not necessarily yours. When you run another team's template, their maintainers approve its steps; your own team's maintainers can't, unless they also maintain that team. Whoever started the run can never decide on it, even as a maintainer of that team: two people agree before it runs.

If you may decide, the step shows **Approve**, **Decline…** (with an optional reason, `Why (shown with the step)`) and, when its product has a plan, **Preview what it would do**, which previews it with the inputs it will really get. Your home page lists what's waiting for you under **Needs you**, and the notification bell tells you when a step starts waiting.

Declined, the step fails with `APPROVAL_DECLINED` and the run fails. Undecided for 3 days (unless your install says otherwise), it fails with `APPROVAL_EXPIRED`. Retrying either asks again. More in [Runs, explained](09-runs-explained.md#who-approves-a-step-that-is-awaiting-approval).

Approvals apply the same way to an order from the cart, to a schedule's runs, and to deleting what a run made.

## How do I order several actions together with the cart?

The cart turns several actions into one run, wired together for you: you pick what you want, and the console works out the order, which output feeds which input, and what's missing.

1. In the **Catalog**, choose **Add to cart** on each action you want (templates can't go in the cart). The same action can go in twice; the cart holds up to 50.
2. Open **Cart**. Pick **For team**: the order is placed for one of your teams.
3. Read the plan. Each step lists its inputs and how each is filled:

   | It says | Means |
   | --- | --- |
   | `From <step>'s <output>` | Wired to an earlier step's output of the same type |
   | `Uses <name>` | Filled with something your team (or you) already has, which you chose |
   | `Asked once for the order: <name>` | One value for every input of that type, under **Your order** |
   | A field | Yours to fill in, checked like the run form's |
   | A choice | More than one thing could fill it, or you already have some: pick one of its cards, or a new one |

   A step marked **Added: something in your cart needs it** wasn't in your cart: something you added needs what it makes, and nothing else in the cart provides it.
4. **Optional** suggestions offer to add a provider for an optional input (**Add ...**), or to use what you have (**Use ...**). Nothing is added unless you choose it.
5. **Place order.** It stays disabled while a choice is unmade (`Choose what fills ... first.`) or the steps feed each other in a circle. Then it opens the run, and the cart empties. The run's page keeps what you ordered under **Ordered from the cart**: each action with what you filled in, what the plan added and why, and each choice with the resource it took.

The order is one run for your team. Each step is checked as if you ran its action on its own: it must be shared with you, its inputs must fit, its targets must be allowed, and its approvals apply. So a cart never lets you do more than you could step by step.

Good to know:

- The cart is kept in this browser only. Another browser, or a private window, has its own.
- Changing the team, or adding or removing an action, clears the choices you made.
- Placing it twice from the same visit (say, after a timeout) is the same order, not a second one.
- The chat assistant can fill a cart for you. Its answer lists the cart as the order would run it: each step's team, product and verb, what it takes from an earlier step, and what the plan adds. **Open in cart** replaces what's in yours with its proposal, and you still make its choices and place it yourself.

## How do I compose a template by hand?

**Catalog → Compose** builds a template from the actions shared with you, when you want to keep and reuse a combination, or get it reviewed into the catalog.

1. Under **Add a step**, choose **+** beside each action you want (one not shared with you shows a lock: ask its team for it). Inputs that need what an earlier step makes are wired to it as you add.
2. Pick a step in the list to set its **Step id** and, for each input, where it comes from: **Not given**, **A value**, **Asked when it runs** (a field on the template's form), or an earlier step's output (`From <step> → <output>`). Outputs of the matching type are marked `✓ same type`. **Remove the step** takes it out.
3. **Checks**, above the steps, lists what's wrong, or that every required input is given, and what it will ask when it runs.
4. Under **The template**, give it a **Name** (its file is `dags/<name>.yaml`), **For team** (the catalog folder that will own it), and optionally a **Display name** and **Description**. The file shows as it stands.

Then:

- **Propose as a template ↗** opens the catalog repository's new-file page with the file filled in, in your browser. Open a pull request there for its team to review. When the repository isn't known, **Copy the file** and add it to `teams/<team>/dags/` yourself.
- **Run now** runs it straight away, as a DAG. It works only when nothing is asked when it runs and every step is a product of a team you maintain.

**Build from a cart**, on the same page, wires several actions at once: choose them under **Actions** (or **Use your cart**), then **Wire them**. They're put in an order they can run, each input wired to what provides its type, and anything else they need added. It replaces the steps below. When more than one thing could fill an input, pick one of its cards, and the steps are wired again. **Use your cart** fills the list from the Catalog's **Cart**; the cart itself is left as it is.

**Drafts** are kept by the console as you go, for the draft's team: its members see and change them from any device. Pick one to open it, **New** to start another, or the bin to delete it. If someone else saved the same draft since you opened it, you're asked to **Load theirs** or **Keep mine**. Drafts still kept only in this browser are offered to the console: **Move them**.

## How do I run something on a schedule?

From a template's or action's form, a maintainer of one of the teams it can run for sees **Schedule…**. Fill in the form first: the schedule runs with those inputs every time.

| Field | What to give |
| --- | --- |
| **Name** | What the team will know it by |
| **For team** | One of the teams you maintain that it may run for |
| **When** | A common time (**Every hour**, **Every day at 02:00**, **Weekdays at 09:00**, ...) or **Another time (cron)** |
| **Cron** | Minute, hour, day of the month, month, day of the week. At most every five minutes |
| **Time zone** | Such as `Europe/Berlin`, or `UTC` |
| **Runs as** | One of the team's bots. With none, add one on the team's **Automation** tab first |

**Schedule it** opens the team's **Schedules** tab.

Each run starts as the bot, never as you, with the bot's access as it is then, and through every check the bot running it itself would get. If the bot can't run it any more, that start is refused: the tab's **Last** column shows why, and the team's maintainers are told.

Every member sees the team's **Schedules** tab: what each runs, **When** (with the next time), **Runs as**, and **Last** (a link to its last run, or its last error). Maintainers turn one off and on with **On**, **Edit** when it runs, as which bot, and its inputs (**Change inputs…** opens this run form with them, and **Save to schedule** keeps the changes), and **Delete** it; the runs it started stay. To run something else, make a new one. A run a schedule started says so, **on the schedule** and its name, in **Runs** and on the run's page, where the name links to the team's **Schedules** tab. More for maintainers in [Bots and automation](14-bots-and-automation.md#how-do-i-run-something-on-a-schedule).

## Where do I find what a run made, and how do I delete it?

A product can report what its steps made or changed (a project, a ticket, a service). The console keeps that list after the run itself is deleted, so you can find it and clean it up later.

- **On a run's page**, **What this run made** lists it, within a minute of the run finishing.
- **Runs → What runs made** lists everything made for your teams, or for you, newest first. Search by type, id or name, or narrow it by whom it was made for, its type or its state; **Show deleted** includes what's gone. Tick several of one team's and **Delete** them together: each one's cleanup runs, in one run, newest first.

Each row shows **What** (linked, when the product gave a link), **Made for**, **By** (the product and the run), **Made**, and **State**:

| State | Means |
| --- | --- |
| **Made** | It exists, as far as Vertra knows |
| **Deleting** | Its cleanup is running; the pill links to that run |
| **Delete failed** | Its cleanup failed; the pill links to the run. You can try again |
| **Deleted** | Its cleanup succeeded |

A row also says what it uses (`Uses ...`) and what uses it (`Used by ...`, including how many you can't see).

**Delete** appears when you may delete it (you ran it, it was made for your team, or you're an admin) and its product says how. It runs that product's current cleanup action as a run of its own, for the team it was made for, and opens that run. The cleanup gets the same checks as running the action: it must be shared with you, and its approvals apply. **Delete all** on a run's page deletes everything it made that's left, newest first, one after another, in one run.

Something other resources still use isn't deleted on your say. **Delete** then offers **Ask an admin** instead: the request appears under **Waiting for an admin** at the top of **What runs made** until an admin chooses **Approve and delete** or **Deny**. To skip that, delete what uses it first.

## Where to look next

- [Runs, explained](09-runs-explained.md): a run's states, retries, cancelling, failure codes and logs.
- [Bots and automation](14-bots-and-automation.md): running these from a pipeline, schedules, and notifications.
- [Calling the API](05-calling-the-api.md#wiring-a-cart-of-actions): the cart and templates over the API.
- [What's a DAG](03-what-is-a-dag.md) and [How data moves](07-how-data-moves.md): what a template becomes, and how one step's output reaches the next.
- The [security model](security-model.md#consumers-and-templates): exactly what running another team's template may and may not do.
