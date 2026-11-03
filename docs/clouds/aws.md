# Getting AWS ready for Vertra

What only the AWS website can do, before `vertra init`. `init` checks
the rest itself (who you're signed in as, which regions answer, budgets) and
links back here when something needs fixing.

## An account

You need an **AWS account**: one you create at
<https://signup.aws.amazon.com/> with an email and a password (a card and a
phone check are part of it), and that has a 12-digit account ID.

- **Not an AWS account:** an *AWS Builder ID* ("Sign in with Google", used for
  Amazon Q, Kiro, re:Post or Skill Builder). It has no account ID and can't
  create anything.
- **A dedicated account is safest:** Vertra creates a cluster, a network,
  roles and buckets; an account of its own (or a member account of your
  organization) keeps that apart from anything else.
- **Already in an organization?** Some sign-up flows put a new account in an
  AWS Organization with guardrails (service control policies). That's fine:
  `init` shows which regions the policies allow. An account's *management*
  account is better left for billing and organization settings; put Vertra
  in a member account.

## Protect the root user

The email-and-password sign-in is the account's **root user**: everything,
always. Use it only for account settings.

1. Sign in at <https://signin.aws.amazon.com/> → **Root user** (a private
   window avoids remembered sessions).
2. Account menu → **Security credentials** → **Assign MFA device**.
3. Never create access keys for root.

## A budget

Billing and Cost Management → **Budgets** → **Create budget** → **Monthly
cost budget** (or *Zero spend*), with your email. `init` offers to create one
in the account Vertra uses if it has none.

## An IAM user

For one person, an IAM user with console access is the simplest way to sign
the CLI in, with no keys on disk (`aws login`):

1. As root (or an administrator) in the account Vertra will use: **IAM** →
   **Users** → **Create user**, e.g. `rburns`.
2. Tick **Provide user access to the AWS Management Console** → *I want to
   create an IAM user* → set a password.
3. **Attach policies directly** → **AdministratorAccess** → **Create user**.
4. Open the user → **Security credentials** → **Assign MFA device**.
5. Don't create access keys.

For a team, use **IAM Identity Center** instead: enable it with AWS
Organizations (an *organization instance*; an *account instance* can't
give access to AWS accounts, only to applications), create users, a
permission set (AdministratorAccess), and assign both to the account. Then
sign in with `aws configure sso`.

## Sign in

```
aws login --profile vertra          # an IAM user: opens your browser
aws configure sso --profile vertra  # Identity Center
```

`vertra init` offers to run the first for you. It refuses root.

## Regions

`init` asks every common region whether it answers for your account and
offers those that do. A region you've opted in to isn't one of them: give
it with `--region`, and it's asked and offered too. If your organization's policy allows only some (a
region restriction), pick one of them, or have the organization's
management account allow another (AWS Organizations → Policies → Service
control policies). us-east-2 costs the same as us-east-1 for everything
Vertra uses.

## A managed database

`vertra init --database managed` (or the question it asks) makes Amazon RDS
for PostgreSQL instead of Postgres in the cluster: in the install's VPC with
no public access, each service signing in as its own role, AWS's backups
with point-in-time recovery, Multi-AZ if chosen. About $26 a month at
`minimal`, priced on the approval screen. The IAM user `vertra` signs in as
needs RDS, Secrets Manager (RDS keeps its administrator's password there)
and EC2 security groups, which the policy above has. How it works, and how to
restore: [Databases](../operations.md#databases).

## The chat agent

On AWS the console's **Ask** panel answers with Claude in Amazon Bedrock,
in the install's region, as the console's own role: no key. `vertra
apply` grants that role `bedrock-mantle:CreateInference` on the one model
(`anthropic.claude-sonnet-5` unless `chat.model` names another of Bedrock's
Claude models; `chat.off: true` turns it off and grants nothing).

Before an account's first use of Anthropic's models, AWS asks for its use
case once: Amazon Bedrock → Model catalog → any Claude model → **Submit use
case details** (who you are and what it's for), then accept the model's
terms. Until then every call is refused ("not available for this account";
`aws bedrock get-foundation-model-availability --model-id
anthropic.claude-sonnet-4-5-20250929-v1:0` says `NOT_AUTHORIZED`), and the
Admin page's **Test** says so.

A newer or little-used account may also start with every Bedrock daily
token quota at 0, for every model of every provider, which Service Quotas
won't let you raise (`aws service-quotas list-service-quotas
--service-code bedrock` shows them); calls then fail as "model does not
exist" or "Too many tokens per day". Ask AWS Support to raise them, naming
the model. You pay Bedrock for what it's asked, a few
cents a conversation.

AWS may refuse an account Anthropic's models (often a new or low-spend
one; replying on the case with the use case can change that). `vertra init`
asks Bedrock whether the account may use the model, and leaves the chat off
when it may not (`--chat true` turns it on anyway); with the chat on,
`vertra check` and `vertra apply` ask again and warn if access was refused
or withdrawn since. The chat then works
another way: an admin sets the provider to Anthropic, with an API key, on
the Admin page's Chat settings (the key is kept sealed in the console's
database), so its conversations go to Anthropic's API rather than staying
in AWS. Once Bedrock access is granted, `vertra config set -e <env> chat.off
false` and `vertra apply`.

## Next

[Setting up Vertra](../setup.md): `vertra init`, what each question decides, and what to expect from `vertra apply`.
