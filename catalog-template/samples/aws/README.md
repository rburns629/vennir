# aws: real AWS calls

Example products that call real AWS APIs, to copy from when your product has
to. Running them costs money. Proven on EKS Auto Mode (2026-10-19): each
product as its own ServiceAccount, bound by EKS Pod Identity to its own IAM
role with the permissions below, the DAG and the database run for real. The
SecretStore isn't proven yet.

| Product | What `create` does |
|---|---|
| [`s3-bucket`](products/s3-bucket/) | Finds a bucket by name, or creates it with all public access blocked. A name another account owns fails with `BUCKET_NAME_TAKEN` |
| [`ecs-express`](products/ecs-express/) | Deploys an image from the team's registry as an ECS Express Mode service, AWS's counterpart to Cloud Run (Fargate tasks behind a load balancer AWS manages, at an HTTPS URL), and waits for it to serve, or returns the existing service's URL. Run with the roles the team chose ([Hosting an app](#hosting-an-app-ecs-express)) |
| [`rds-postgres`](products/rds-postgres/) | Finds an RDS for PostgreSQL instance, or creates it (encrypted, not public) and waits until it's available, several minutes: set `timeoutSeconds` to 1500 or more, and delete it after |
| [`caller-identity`](products/caller-identity/) | `whoami`: signs in as a role with the step's own projected ServiceAccount token, from a cluster that isn't EKS (GKE, AKS, kind), and says who AWS says it is. Free: STS only. See [AWS from another cluster](#aws-from-another-cluster) |

Every action looks before it creates, so a retried step is harmless.

## Deleting what they made

Each `create` tags what it makes `vennir-made=true` and
`vennir-team=<the team it was made for>` (the request's `forTeam`: the
team the run is for, which for a shared product's run is the consumer's,
not this one's), and reports it as `resources`, with a `delete` action as
its `cleanup`: Delete on the run page (or **What runs made**) runs it. A
delete refuses anything without the tag (`NOT_MADE_BY_VENNIR`), so a
bucket, service or database that was only found, never made, is never
deleted; and anything whose `vennir-team` isn't the run's `forTeam`
(`NOT_THIS_TEAMS`), so one team's delete, even run directly, can't remove
another team's. A request with no `forTeam` (a person's run for no team,
by someone outside this team) is refused (`MISSING_TEAM`). A create
reports what it finds as made only when both tags match the same way. One
already gone counts as deleted.
The console lets only the team it was made for, whoever ran it, and admins
delete it. Some deletes are careful on purpose:

- `s3-bucket` refuses a bucket that still holds objects
  (`BUCKET_NOT_EMPTY`) rather than emptying it.
- `rds-postgres` keeps a final snapshot, named in its output
  (`finalSnapshot`): delete the snapshot once nobody needs the data, since
  it's billed as storage.
- ECS (its load balancer and the rest it made for the service) and RDS
  finish a delete on their own once it's accepted, so the step doesn't
  wait for it.

Made before they were tagged with a team (before 2026-11-03), a bucket,
service or instance has `vennir-made` but no `vennir-team`, so its delete
refuses it (`NOT_THIS_TEAMS`). Tag it by hand with the team it was made for
(`vennir-team=<team>`: `aws s3api put-bucket-tagging`, which replaces every
tag, so give `vennir-made=true` again too; `aws ecs tag-resource`;
`aws rds add-tags-to-resource`), then delete it again, or delete it outside
Vennir.

Proven on EKS Auto Mode (2026-10-25): each made by one team's member,
refused to another team's, the bucket refused while it held an object, and
all three deleted by an admin's cleanup run (the database's final snapshot
kept).
[dags/aws-hello-world-dag.yaml](dags/aws-hello-world-dag.yaml) chains the
first two: the service runs in the bucket's region.

## No passwords

`rds-postgres` never sees its database's password: RDS generates it and keeps
it in AWS Secrets Manager, and the step outputs that secret's ARN. Give an
app's own IAM role read access to that one secret rather than passing the
password along, since a step's outputs are readable by anyone who can see
the execution.

## Credentials

No keys: the actions use boto3's default credential chain, which EKS fills in
for the step's Kubernetes ServiceAccount. Each product runs as its own
(`serviceAccount` in its `product.yaml`: `aws-s3-bucket`, `aws-ecs-express`,
`aws-rds-postgres`), which the console creates in the `aws` namespace, and
only that product's image may run as it. Bind each to its own role, either:

- **EKS Pod Identity** (simplest): install the Pod Identity agent add-on and
  create an association from that ServiceAccount to an IAM role. Nothing on
  the ServiceAccount or Pod changes.
- **IRSA**: an IAM OIDC provider for the cluster, and the annotation
  `eks.amazonaws.com/role-arn: <role>` on the ServiceAccount (an admin adds
  it; the console never changes a product's ServiceAccount).
- **Off EKS** (GKE, AKS, any cluster whose issuer AWS can reach): an IAM OIDC
  provider for the cluster's issuer (audience `sts.amazonaws.com`), and a
  role per product trusting it for exactly that product's ServiceAccount
  (`system:serviceaccount:aws:aws-s3-bucket`, and so on), registered as the
  team secret named after it with `-role` (`aws-s3-bucket-role`,
  `aws-ecs-express-role`, `aws-rds-postgres-role`), key `role-arn`.
  Uncomment its `secretRefs` line on every action in `product.yaml`
  (`create`, `delete` and `check`): a template's steps, the Catalog's
  runs and Delete get only what their action lists. A hand-written DAG
  lists it per step instead. The product finds no default
  credentials, so it assumes that role by web identity with its step's own
  token. Another product of the team mounting the same secret can't use it:
  the role's trust names one ServiceAccount.

`aws-target`, when the team registers it, means the same on and off EKS: a
second role each product assumes as its own, for the calls themselves.

Grant each product's role only what it calls:

| Product | IAM actions |
|---|---|
| `s3-bucket` | `s3:ListBucket` (for HeadBucket), `s3:CreateBucket`, `s3:PutBucketPublicAccessBlock`, `s3:TagResource` (it's created tagged), `s3:GetBucketTagging`, and for delete `s3:DeleteBucket`, on `arn:aws:s3:::<prefix>*` |
| `ecs-express` | `ecs:CreateExpressGatewayService`, `ecs:DescribeExpressGatewayService`, `ecs:DescribeServices`, and for delete `ecs:DeleteExpressGatewayService`, on `arn:aws:ecs:*:<account>:service/default/*`; `ecs:TagResource` there, only as it creates (condition `ecs:CreateAction` = `CreateExpressGatewayService`); `ecs:RegisterTaskDefinition` on `task-definition/default-*` and `ecs:CreateCluster` on `cluster/default` (it registers the service's task definition, and makes the default cluster on first use); `iam:PassRole` on the team's two roles alone, with `iam:PassedToService` `ecs-tasks.amazonaws.com` or `ecs.amazonaws.com` ([Hosting an app](#hosting-an-app-ecs-express) has the policy) |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, and for delete `rds:DeleteDBInstance` and `rds:CreateDBSnapshot` (its final snapshot), plus `secretsmanager:CreateSecret`, `secretsmanager:TagResource` and `kms:DescribeKey` for the managed password (and `secretsmanager:DeleteSecret`, which RDS uses to remove it) |

Upgrading: `s3-bucket` used to tag a bucket after making it, with
`s3:PutBucketTagging`; it now makes it tagged, which needs `s3:TagResource`.
Add that to a role granted from an older copy of this table, or every
create fails with an AccessDenied that names it.

The first ECS service or RDS instance in an account also needs that
service's service-linked role (ECS: "Unable to assume the service linked
role"). Either create it once yourself (`aws iam
create-service-linked-role --aws-service-name ecs.amazonaws.com`, and
`rds.amazonaws.com`) or let the product's role do it:
`iam:CreateServiceLinkedRole` on
`arn:aws:iam::<account>:role/aws-service-role/<service>/AWSServiceRoleFor<ECS|RDS>`,
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
refusing kind's private issuer (`TOKEN_NOT_TRUSTED`).

`s3-bucket`, `ecs-express` and `rds-postgres` run off EKS the same way
(see Credentials): each declares the same `tokenAudiences`, and with no
default credentials assumes its own role by web identity, named by the
team secret `<its ServiceAccount>-role`. Proven on GKE (2026-11-07) for
`s3-bucket`: a bucket made, tagged and private, then deleted, in an account
with no AWS cluster.

## Hosting an app (ecs-express)

What a Cloud Run service is on Google Cloud, an ECS Express Mode service is
on AWS: give it an image and it runs it on Fargate behind a load balancer
it makes and manages, at `https://<id>.ecs.<region>.on.aws`, scaling by
CPU (at least one task, so never to zero). AWS closed App Runner to new
accounts in 2026 and points to it instead.

What a service deploys, and with what, is the team's choice, not the
caller's. Once per account, as an admin:

```bash
# The task execution role: pulls the image, writes its logs.
aws iam create-role --role-name aws-ecs-execution --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name aws-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
# The infrastructure role: makes each service's load balancer, security groups and scaling.
aws iam create-role --role-name aws-ecs-infrastructure --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name aws-ecs-infrastructure \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
# ECS's own role, once per account.
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
```

Then a maintainer adds the team secret `ecs-express`:

| Key | Value |
|---|---|
| `image-registry` | The prefix every image must be under, such as `<account>.dkr.ecr.us-east-2.amazonaws.com/aws` (`IMAGE_OUTSIDE_REGISTRY` otherwise). The execution role may pull from any ECR repository in the account, so narrow it with a repository policy if that matters |
| `execution-role-arn` | `arn:aws:iam::<account>:role/aws-ecs-execution` |
| `infrastructure-role-arn` | `arn:aws:iam::<account>:role/aws-ecs-infrastructure` |

The product's own role (`aws-ecs-express`, bound as in Credentials) gets
the actions in the table above, passing only those two roles:

```json
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Resource": "arn:aws:ecs:*:<account>:service/default/*",
   "Action": ["ecs:CreateExpressGatewayService", "ecs:DescribeExpressGatewayService",
              "ecs:DeleteExpressGatewayService", "ecs:DescribeServices"]},
  {"Effect": "Allow", "Action": "ecs:TagResource", "Resource": "arn:aws:ecs:*:<account>:service/default/*",
   "Condition": {"StringEquals": {"ecs:CreateAction": "CreateExpressGatewayService"}}},
  {"Effect": "Allow", "Action": "ecs:RegisterTaskDefinition", "Resource": "arn:aws:ecs:*:<account>:task-definition/default-*"},
  {"Effect": "Allow", "Action": "ecs:CreateCluster", "Resource": "arn:aws:ecs:*:<account>:cluster/default"},
  {"Effect": "Allow", "Action": "iam:PassRole",
   "Resource": ["arn:aws:iam::<account>:role/aws-ecs-execution", "arn:aws:iam::<account>:role/aws-ecs-infrastructure"],
   "Condition": {"StringEquals": {"iam:PassedToService": ["ecs-tasks.amazonaws.com", "ecs.amazonaws.com"]}}}
]}
```

- **The app gets no AWS role.** It can call nothing in AWS. A team that
  wants its app to read a bucket, say, makes that role and adds a
  `taskRoleArn` to its copy of `create`, and the role's PassRole above.
- **Where it runs.** The region's default VPC, internet-facing, unless the
  run gives `subnets` (private ones give an internal load balancer). The
  region needs a default VPC otherwise.
- **What it costs.** A task at the default 0.25 vCPU and 512 MiB while it
  runs (it never scales to zero), and the Application Load Balancer AWS
  makes for it, billed by the hour while it's there.
- **How long.** About five minutes until a new service serves: give the
  step `timeoutSeconds: 1200`. Its URL resolves only once its deployment
  is done; a lookup before that can be cached as missing for a few minutes.
  `create` waits for the deployment, then (for a public one) for its health
  check path to answer at the URL, since the load balancer can say 503 for
  a few seconds after.
- **What delete leaves.** Each service's log group
  (`/aws/ecs/default/<service>-<id>`), kept as CloudWatch keeps it: set
  its retention, or delete it once nobody needs the logs.

Proven (2026-11-07), running the product's image as the kernel would, with
a role of exactly the policy above: its check ready in the registry's
region; a service made from a private ECR image in us-east-2 (the first in
the account: the default cluster made on the way, after the service-linked
role), serving the moment the step ended; found again by a second create
and left alone; refused to another team's delete, and deleted; an image
outside the registry refused before any call. Proven from GKE the same day
(the 0.13.2 release, the role by web identity): the check ready, a member's
template run serving an API's backend on its first attempt, published
through the gateway to the internet, and its run's Delete.

## An API on it (greetings)

[`apis/greetings`](apis/greetings/) publishes a backend on ECS Express
Mode through the gateway, and [`dags/greetings-backend.yaml`](dags/greetings-backend.yaml)
hosts that backend with `ecs-express`. The backend is
`examples/greetings-api` in the platform's repository: it greets someone by
name, and answers only requests whose `Vennir-Caller` the gateway signed.

1. **The image**, under the team's registry, a tag per version:
   `docker buildx build --platform linux/amd64 -t <registry>/greetings:1 --push examples/greetings-api`.
2. **The gateway on the internet**: the backend fetches the gateway's
   public keys from `https://<its public host>/.vennir/jwks.json`, which
   only the internet listener serves (the gateway guide, Putting it on the
   internet), and an admin allows `*.ecs.<region>.on.aws` in
   `gateway.backendHosts`.
3. **Run the template** with the image and that keys URL, then read the
   step's `serviceUrl`.
4. **Publish the API**: put that URL in `api.yaml`'s `backend.url` and
   `openapi.yaml`'s `servers`, and open a pull request.

Express Mode's URL is public, and its load balancer takes no IAM
signature, so the API has no `auth`: the backend checks the gateway's
signature on every request (401 otherwise). It can't be told its own URL
before ECS makes it, so the template sets `AUDIENCE_FROM_HOST=true`: the
audience it checks is the request's own origin, which Express Mode's
load balancer, routing each service by its host, makes sound. Its health
check (`/healthz`, 200) isn't in `openapi.yaml`, so the gateway never
forwards it. Take the API out of the catalog before its run's Delete
removes the backend. Proven (2026-11-07) from GKE with this backend's
logic: the template's run serving, the API answering through the
gateway from the internet, and the backend refusing every request that
didn't come through it.

## Is it ready here?

Each product's `check` (product.yaml) says whether it's ready on an install,
and the console runs it when the product is registered, daily, and on
**Check now**. It changes nothing: it signs in as create does, asks STS who
it is (the `principal` it reports), assumes `aws-target` when listed, then
makes the read-only calls its role must allow, in the cluster's region
(`AWS_REGION`, else us-east-1: off EKS there's no cluster region, so
us-east-1; `ecs-express` asks in its team registry's region first, when
that's an ECR one), since each run's region is an input. An organization
policy denying us-east-1 then makes a check not ready, naming an action for
the product's role that the role isn't what's refusing:

| Product | Asks | Missing names |
|---|---|---|
| `s3-bucket` | nothing more: its S3 actions are granted on bucket names, and a check names none, so only a create finds out | only an IAM role, when none is bound |
| `ecs-express` | the team's `ecs-express` secret, then `ecs:DescribeExpressGatewayService` (of a service that doesn't exist: not found means it may) | the secret, or that action for its role |
| `rds-postgres` | `rds:DescribeDBInstances`, and `kms:DescribeKey` on `alias/aws/secretsmanager` | those actions, for its role |

With no role bound to its ServiceAccount, or a role that won't let it in or
let it assume `aws-target`, it isn't ready, and says what's missing. The
actions with no read-only form (creating, tagging, deleting) only a create
or delete finds out. Seen from GKE (2026-11-07): `s3-bucket` ready as its
own role.

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from AWS Secrets Manager through External Secrets Operator,
signing in as `eso-aws` the same keyless way.
