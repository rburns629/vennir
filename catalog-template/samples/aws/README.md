# aws: real AWS calls

Example products that call real AWS APIs, to copy from when your product has
to. Running them costs money. Proven on EKS Auto Mode (2026-10-19): each
product as its own ServiceAccount, bound by EKS Pod Identity to its own IAM
role with the permissions below, the DAG and the database run for real. The
SecretStore isn't proven yet.

| Product | What `create` does |
|---|---|
| [`s3-bucket`](products/s3-bucket/) | Finds a bucket by name, or creates it with all public access blocked. A name another account owns fails with `BUCKET_NAME_TAKEN` |
| [`app-runner`](products/app-runner/) | Deploys an image (ECR or ECR Public) as an App Runner service and waits for it to run, or returns the existing service's URL once it runs. Private unless `public: true` |
| [`rds-postgres`](products/rds-postgres/) | Finds an RDS for PostgreSQL instance, or creates it (encrypted, not public) and waits until it's available, several minutes: set `timeoutSeconds` to 1500 or more, and delete it after |
| [`caller-identity`](products/caller-identity/) | `whoami`: signs in as a role with the step's own projected ServiceAccount token, from a cluster that isn't EKS (GKE, AKS, kind), and says who AWS says it is. Free: STS only. See [AWS from another cluster](#aws-from-another-cluster) |

Every action looks before it creates, so a retried step is harmless.

## Deleting what they made

Each `create` tags what it makes `vertra-made=true` and
`vertra-team=<the team it was made for>` (the request's `forTeam`: the
team the run is for, which for a shared product's run is the consumer's,
not this one's), and reports it as `resources`, with a `delete` action as
its `cleanup`: Delete on the run page (or **What runs made**) runs it. A
delete refuses anything without the tag (`NOT_MADE_BY_VERTRA`), so a
bucket, service or database that was only found, never made, is never
deleted; and anything whose `vertra-team` isn't the run's `forTeam`
(`NOT_THIS_TEAMS`), so one team's delete, even run directly, can't remove
another team's. A run for no team (`MISSING_TEAM`) is refused. A create
reports what it finds as made only when both tags match the same way. One
already gone counts as deleted.
The console lets only the team it was made for, whoever ran it, and admins
delete it. Some deletes are careful on purpose:

- `s3-bucket` refuses a bucket that still holds objects
  (`BUCKET_NOT_EMPTY`) rather than emptying it.
- `rds-postgres` keeps a final snapshot, named in its output
  (`finalSnapshot`): delete the snapshot once nobody needs the data, since
  it's billed as storage.
- App Runner and RDS finish a delete on their own once it's accepted, so
  the step doesn't wait for it.

Made before they were tagged with a team (before 2026-11-03), a bucket,
service or instance has `vertra-made` but no `vertra-team`, so its delete
refuses it (`NOT_THIS_TEAMS`). Tag it by hand with the team it was made for
(`vertra-team=<team>`: `aws s3api put-bucket-tagging`, which replaces every
tag, so give `vertra-made=true` again too; `aws apprunner tag-resource`;
`aws rds add-tags-to-resource`), then delete it again, or delete it outside
Vertra.

Proven on EKS Auto Mode (2026-10-25): each made by one team's member,
refused to another team's, the bucket refused while it held an object, and
all three deleted by an admin's cleanup run (the database's final snapshot
kept).
[dags/aws-hello-world-dag.yaml](dags/aws-hello-world-dag.yaml) chains the
first two.

## No passwords

`rds-postgres` never sees its database's password: RDS generates it and keeps
it in AWS Secrets Manager, and the step outputs that secret's ARN. Give an
app's own IAM role read access to that one secret rather than passing the
password along, since a step's outputs are readable by anyone who can see
the execution.

## Credentials

No keys: the actions use boto3's default credential chain, which EKS fills in
for the step's Kubernetes ServiceAccount. Each product runs as its own
(`serviceAccount` in its `product.yaml`: `aws-s3-bucket`, `aws-app-runner`,
`aws-rds-postgres`), which the console creates in the `aws` namespace, and
only that product's image may run as it. Bind each to its own role, either:

- **EKS Pod Identity** (simplest): install the Pod Identity agent add-on and
  create an association from that ServiceAccount to an IAM role. Nothing on
  the ServiceAccount or Pod changes.
- **IRSA**: an IAM OIDC provider for the cluster, and the annotation
  `eks.amazonaws.com/role-arn: <role>` on the ServiceAccount (an admin adds
  it; the console never changes a product's ServiceAccount).

Grant each product's role only what it calls:

| Product | IAM actions |
|---|---|
| `s3-bucket` | `s3:ListBucket` (for HeadBucket), `s3:CreateBucket`, `s3:PutBucketPublicAccessBlock`, `s3:TagResource` (it's created tagged), `s3:GetBucketTagging`, and for delete `s3:DeleteBucket`, on `arn:aws:s3:::<prefix>*` |
| `app-runner` | `apprunner:ListServices`, `apprunner:DescribeService`, `apprunner:CreateService`, `apprunner:TagResource`, `apprunner:ListTagsForResource`, and for delete `apprunner:DeleteService`; `iam:PassRole` on the ECR access role if you use one |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, and for delete `rds:DeleteDBInstance` and `rds:CreateDBSnapshot` (its final snapshot), plus `secretsmanager:CreateSecret`, `secretsmanager:TagResource` and `kms:DescribeKey` for the managed password (and `secretsmanager:DeleteSecret`, which RDS uses to remove it) |

Upgrading: `s3-bucket` used to tag a bucket after making it, with
`s3:PutBucketTagging`; it now makes it tagged, which needs `s3:TagResource`.
Add that to a role granted from an older copy of this table, or every
create fails with an AccessDenied that names it.

The first App Runner service or RDS instance in an account also makes that
service's service-linked role. Either create it once yourself (`aws iam
create-service-linked-role --aws-service-name apprunner.amazonaws.com`, and
`rds.amazonaws.com`) or let the product's role do it:
`iam:CreateServiceLinkedRole` on
`arn:aws:iam::<account>:role/aws-service-role/<service>/AWSServiceRoleFor<AppRunner|RDS>`,
with the condition `iam:AWSServiceName` equal to the service. RDS can refuse
the create right after making its role; the step fails as retryable and
the next attempt goes through.

An EKS Pod Identity role trusts `pods.eks.amazonaws.com` for
`sts:AssumeRole` and `sts:TagSession`; narrow it with the conditions
`aws:SourceAccount` (your account) and `aws:SourceArn` (the cluster's ARN).

Optionally, register a team secret `aws-target` whose key `role-arn` is a
role's ARN, and list it in each action that should act as it
(`secretRefs: [{name: aws-target, keys: [role-arn]}]`): those steps then use
their own credentials only to assume that role (`sts:AssumeRole`, which the
target's trust policy must allow) and act as it. Each team, and each
product, chooses its own. List it in the product's `check` too, so the check
asks as the role the actions act as.

## AWS from another cluster

`caller-identity` is the pattern for a product that runs on GKE, AKS or any
cluster other than EKS and calls AWS, with no key and no stored secret. Its
`product.yaml` declares `tokenAudiences: [sts.amazonaws.com]`, so each of
its steps gets an hour-long token for its own ServiceAccount, signed by the
cluster's OIDC issuer, at `/platform/tokens/sts.amazonaws.com`. `whoami`
hands that token to STS's `AssumeRoleWithWebIdentity` (an unsigned call: the
token is the proof) for the role it's given, asks who the session is, and
outputs the account and ARN, never the credentials.

To let it in, once per account and cluster:

1. **An IAM OIDC identity provider** for the cluster's issuer URL, with
   `sts.amazonaws.com` as its audience. On GKE the issuer is
   `https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>`;
   `kubectl get --raw /.well-known/openid-configuration` prints any
   cluster's. AWS must be able to fetch its keys from there, so a cluster
   whose issuer isn't public (kind's isn't) can't be trusted.
2. **A role** whose trust policy allows `sts:AssumeRoleWithWebIdentity` from
   that provider, with the conditions `<issuer>:sub` =
   `system:serviceaccount:aws:aws-caller-identity` (this product's
   ServiceAccount, in the team's namespace) and `<issuer>:aud` =
   `sts.amazonaws.com`. Give the role only what your own product will call;
   `whoami` itself needs nothing more.

Then run `whoami` with the role's ARN. Its failures say which part is
missing: `NO_TOKEN` (the step got no token: a hand-made step, or a release
without the product's `tokenAudiences`), `TOKEN_NOT_TRUSTED` (no provider
for the issuer, or AWS can't reach its keys) and `ROLE_NOT_ALLOWED` (the
role's trust policy). Its `check` says whether the step gets its token, and
which issuer and subject a role must trust.

Seen on kind (2026-10-31): the token mounted for the product's
ServiceAccount, the check ready naming its issuer and subject, and real STS
refusing kind's private issuer (`TOKEN_NOT_TRUSTED`). A role that trusts a
GKE cluster's issuer is for the billed run.

## Is it ready here?

Each product's `check` (product.yaml) says whether it's ready on an install,
and the console runs it when the product is registered, daily, and on
**Check now**. It changes nothing: it signs in as create does, asks STS who
it is (the `principal` it reports), assumes `aws-target` when listed, then
makes the read-only calls its role must allow, in the cluster's region
(`AWS_REGION`, else us-east-1), since each run's region is an input:

| Product | Asks | Missing names |
|---|---|---|
| `s3-bucket` | nothing more: its S3 actions are granted on bucket names, and a check names none, so only a create finds out | only an IAM role, when none is bound |
| `app-runner` | `apprunner:ListServices` | that action, for its role |
| `rds-postgres` | `rds:DescribeDBInstances`, and `kms:DescribeKey` on `alias/aws/secretsmanager` | those actions, for its role |

With no role bound to its ServiceAccount, or a role that won't let it in or
let it assume `aws-target`, it isn't ready, and says what's missing. The
actions with no read-only form (creating, tagging, deleting) only a create
or delete finds out. Built, not yet proven on a cloud.

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from AWS Secrets Manager through External Secrets Operator,
signing in as `eso-aws` the same keyless way.
