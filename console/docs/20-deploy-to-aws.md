# Deploy to AWS from Vennir

This guide gets a team's products creating real resources in AWS: S3 buckets, ECS Express Mode services (AWS's counterpart to Cloud Run), RDS for PostgreSQL databases. It's for the team that owns the products and whoever administers IAM in the accounts they'll change. It follows the catalog's `samples/aws` products, which are tested on EKS; your own products work the same way.

No keys are made or stored. Each product runs as a Kubernetes ServiceAccount of its own (`serviceAccount` in its `product.yaml`), and on EKS that ServiceAccount is given an IAM role of its own (EKS Pod Identity). You decide what each role may do, and only that product's image can run as it. Steps can't reach the nodes' instance metadata, so a product never falls back to the node's role.

## Before you start

- **An install on EKS** (`vennir init --target aws`). On GKE, an existing cluster or kind, read [From an install that isn't on EKS](#from-an-install-that-isnt-on-eks) first.
- **Your team**, in the catalog and the console ([Onboarding](17-onboarding.md#phase-5-bring-in-a-team)). Below it's `web`.
- **The AWS CLI**, signed in as someone who may create IAM roles and Pod Identity associations in the install's account.
- **Where resources go**: the install's own account, or another account the products reach through a role there (step 5).

Set these once in your shell:

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-2                       # the install's region
CLUSTER=vennir                         # aws eks list-clusters --region $REGION
TEAM=web                               # your team: its namespace
```

## 1. Copy the products into your team

On a branch of the catalog repository:

1. Copy the products you want from `samples/aws/products/` to `teams/web/products/`.
2. In each `product.yaml`, change `team: aws` to `team: web`, set `owner`, and give `serviceAccount` a name of your own (say `web-s3-bucket`). Any name works except one ending in `-api`.
3. In `teams/web/team.yaml`, add `clouds: [aws]` so these products are only run on AWS installs, and `allowedTargets` if other teams may run them.
4. Open a pull request. After merge, every install registers the products, and the console creates each one's ServiceAccount in the `web` namespace.

Until a role is bound, each product shows **Not ready**: expected.

## 2. A role for each product

A role a product's ServiceAccount assumes through EKS Pod Identity trusts the Pod Identity service, narrowed to your account and cluster:

```bash
cat > trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "pods.eks.amazonaws.com"},
    "Action": ["sts:AssumeRole", "sts:TagSession"],
    "Condition": {
      "StringEquals": {"aws:SourceAccount": "$ACCOUNT"},
      "ArnEquals": {"aws:SourceArn": "arn:aws:eks:$REGION:$ACCOUNT:cluster/$CLUSTER"}
    }
  }]
}
EOF
aws iam create-role --role-name vennir-web-s3-bucket --assume-role-policy-document file://trust.json
```

Then give it only what the product calls, as an inline policy. For `s3-bucket`, limited to bucket names under a prefix of your team's:

```bash
cat > s3-bucket.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:ListBucket", "s3:CreateBucket", "s3:PutBucketPublicAccessBlock",
               "s3:TagResource", "s3:GetBucketTagging", "s3:DeleteBucket"],
    "Resource": "arn:aws:s3:::web-*"
  }]
}
EOF
aws iam put-role-policy --role-name vennir-web-s3-bucket --policy-name s3-bucket --policy-document file://s3-bucket.json
```

The other samples' actions:

| Product | IAM actions |
| --- | --- |
| `s3-bucket` | Above. `s3:TagResource` because a bucket is created tagged |
| `ecs-express` | `ecs:CreateExpressGatewayService`, `ecs:DescribeExpressGatewayService`, `ecs:DescribeServices`, `ecs:DeleteExpressGatewayService` on `service/default/*`; `ecs:TagResource` there as it creates; `ecs:RegisterTaskDefinition` on `task-definition/default-*`; `ecs:CreateCluster` on `cluster/default`; `iam:PassRole` on the team's two roles alone ([Hosting an app](#hosting-an-app-on-ecs-express-mode)) |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, `rds:DeleteDBInstance`, `rds:CreateDBSnapshot`; `secretsmanager:CreateSecret`, `secretsmanager:TagResource`, `secretsmanager:DeleteSecret`, `kms:DescribeKey` (RDS keeps the database's password in Secrets Manager; the step never sees it) |

The first ECS service or RDS instance in an account also needs that service's service-linked role. Make it once yourself:

```bash
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
aws iam create-service-linked-role --aws-service-name rds.amazonaws.com
```

## 3. Bind each role to its product

```bash
aws eks create-pod-identity-association --region $REGION --cluster-name $CLUSTER \
  --namespace $TEAM --service-account web-s3-bucket \
  --role-arn arn:aws:iam::$ACCOUNT:role/vennir-web-s3-bucket
```

An association binds one ServiceAccount, in one namespace, on one cluster. Nothing on the ServiceAccount or the step changes; the step's AWS SDK finds the credentials on its own. `vennir` installs the Pod Identity agent (EKS Auto Mode has it built in).

IRSA works too, if you'd rather: the cluster's issuer is already an IAM OIDC provider, so a role whose trust policy accepts `system:serviceaccount:web:web-s3-bucket` from it, and an admin annotating the ServiceAccount with `eks.amazonaws.com/role-arn`, does the same. The console never changes a product's ServiceAccount itself.

Never bind a role to `default` in a team namespace: every image that isn't a registered product runs as it.

## 4. Optional: deploy into another account

To make resources in another account, give that account a role the product may assume, and register it as a team secret. The product's own role then only needs `sts:AssumeRole` on it:

```bash
# In the target account: a role trusting the product's role in the install's account.
#   Principal: {"AWS": "arn:aws:iam::<install account>:role/vennir-web-s3-bucket"}, Action: sts:AssumeRole
# In the install's account: let the product's role assume it.
aws iam put-role-policy --role-name vennir-web-s3-bucket --policy-name assume-target --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::<target account>:role/web-deployer"}]}'
```

Add a team secret `aws-target` whose key `role-arn` is the target role's ARN, and list it in each action that should act there, and in the product's `check`:

```yaml
    secretRefs:
      - name: aws-target
        keys: [role-arn]
```

Give the target role the actions from step 2's table, in that account. Each team, and each product, can have its own target.

## 5. Check it's ready

Each sample has a readiness check: it signs in as the product, asks STS who it is, assumes `aws-target` if listed, and makes the read-only calls its role must allow, in the install's region. **Catalog → Every product** → the product → **Check now**.

| Product | Asks | If not ready |
| --- | --- | --- |
| `s3-bucket` | Only who it is: its S3 permissions are on bucket names, which a check doesn't have | A role bound to its ServiceAccount |
| `ecs-express` | The team's `ecs-express` secret, and `ecs:DescribeExpressGatewayService`, in the team registry's region when it's an ECR one | The secret, or that action for its role |
| `rds-postgres` | `rds:DescribeDBInstances`, and `kms:DescribeKey` on `alias/aws/secretsmanager` | Those actions, for its role |

Creating, tagging and deleting have no read-only form, so only a real run finds out about those.

## 6. Run it

From the **Catalog**, run the product's `create` action, or a template that chains several. Or paste `samples/aws/dags/aws-hello-world-dag.yaml` into **Runs → Submit a DAG**, with your registry and team in it.

- **Timeouts.** A step has five minutes unless its DAG says otherwise. An RDS instance needs `timeoutSeconds: 1500` or more.
- **Other teams.** When another team runs your products, their target inputs must match your `team.yaml`'s `allowedTargets` for that team, or the run is refused before it starts.
- **Retries are safe.** Each `create` looks before it creates.
- **No passwords in outputs.** `rds-postgres` outputs the ARN of the Secrets Manager secret holding the database's password, never the password: give the app that uses it read access to that one secret.

## 7. Find and delete what it made

Each `create` tags what it makes `vennir-made=true` and `vennir-team=<the team it was made for>`, and reports it. **Runs → What runs made** lists it, and **Delete** runs the product's `delete` action, which refuses anything without both tags matching (`NOT_MADE_BY_VENNIR`, `NOT_THIS_TEAMS`).

- `s3-bucket` refuses a bucket that still holds objects (`BUCKET_NOT_EMPTY`) rather than emptying it.
- `rds-postgres` keeps a final snapshot, named in its output: delete it once nobody needs the data, since it's billed.
- ECS (the service's load balancer and the rest it made) and RDS finish an accepted delete on their own; the step doesn't wait.

## Hosting an app on ECS Express Mode

`ecs-express` is AWS's counterpart to `app-hosting` on Cloud Run: it runs a container image on Fargate behind a load balancer AWS makes and manages, at `https://<id>.ecs.<region>.on.aws`, scaling on CPU (at least one task: it never scales to zero). A new service serves in about five minutes, so give its step `timeoutSeconds: 1200`.

What it deploys, and with what, is your team's choice, not the caller's. An account admin makes the two roles a service runs with, once:

```bash
# The task execution role: pulls the image, writes its logs.
aws iam create-role --role-name web-ecs-execution --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name web-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
# The infrastructure role: makes each service's load balancer, security groups and scaling.
aws iam create-role --role-name web-ecs-infrastructure --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name web-ecs-infrastructure \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com   # once per account
```

Then a maintainer adds the team secret `ecs-express`:

| Key | Value |
| --- | --- |
| `image-registry` | The prefix every image must be under, such as `$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/web` (`IMAGE_OUTSIDE_REGISTRY` otherwise) |
| `execution-role-arn` | `arn:aws:iam::$ACCOUNT:role/web-ecs-execution` |
| `infrastructure-role-arn` | `arn:aws:iam::$ACCOUNT:role/web-ecs-infrastructure` |

The product's own role gets step 2's actions for it, with `iam:PassRole` on those two roles alone (condition `iam:PassedToService`: `ecs-tasks.amazonaws.com`, `ecs.amazonaws.com`), so a run can't deploy as anything stronger; the aws team's README in the catalog has the whole policy. A service runs in the region's default VPC, internet-facing, unless its run gives private `subnets`; the app itself gets no AWS role. Its log group stays after a delete: set its retention. Proven (2026-11-07), running the product's image as the kernel would, with a role of exactly that policy: a service made from a private ECR image in us-east-2 and serving the moment the step ended, found again by a second create, refused to another team's delete, and deleted; an image outside the registry refused before any call. Proven from GKE the same day, from the 0.13.2 release: the check **Ready** as its own role, a member's template run serving on its first attempt, and its run's **Delete**; ECS removed the load balancer, target groups and security group on its own. To publish a service as an API through the gateway: [An ECS Express Mode service](21-api-gateway.md#an-ecs-express-mode-service-no-auth).

## Writing your own AWS product

Start from the closest sample and keep what makes it safe: a `serviceAccount` of its own with a role that allows only its calls (the SDK's default credential chain finds it); a readiness check making the read-only calls its actions need; look before you create; tag what you make with `vennir-made` and `vennir-team` (the request's `forTeam`), report it in `resources`, and give it a `cleanup` action that deletes only what carries both; never return a credential in `result.json`. Every field is in [the catalog guide](catalog-guide.md#productyaml).

## From an install that isn't on EKS

**On GKE, or any cluster whose token issuer is public**, AWS can trust a product's own token, with no key: the `caller-identity` sample does exactly this. Its `product.yaml` declares `tokenAudiences: [sts.amazonaws.com]`, so each step gets an hour-long token for its own ServiceAccount at `/platform/tokens/sts.amazonaws.com`, and hands it to STS's `AssumeRoleWithWebIdentity`.

1. **The cluster's issuer** (on GKE it's `https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>`). Read it from the install's own cluster: `vennir apply` doesn't switch kubectl's context to it, so pass `--context` (on GKE, `gke_<project>_<region>_<cluster>`) or another cluster's issuer is trusted instead.

   ```bash
   ISSUER=$(kubectl --context gke_my-vennir-project_us-central1_vennir get --raw /.well-known/openid-configuration | jq -r .issuer)
   ISSUER_HOST=${ISSUER#https://}
   aws iam create-open-id-connect-provider --url "$ISSUER" --client-id-list sts.amazonaws.com
   ```

2. **A role per product**, trusting that provider for exactly its ServiceAccount, with only what the product calls ([A role for each product](#2-a-role-for-each-product) has each sample's actions; `whoami` needs none):

   ```bash
   SA=web-caller-identity                 # the product's serviceAccount
   cat > trust-$SA.json <<EOF
   {"Version": "2012-10-17", "Statement": [{
     "Effect": "Allow",
     "Principal": {"Federated": "arn:aws:iam::$ACCOUNT:oidc-provider/$ISSUER_HOST"},
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {"StringEquals": {
       "$ISSUER_HOST:sub": "system:serviceaccount:$TEAM:$SA",
       "$ISSUER_HOST:aud": "sts.amazonaws.com"
     }}
   }]}
   EOF
   aws iam create-role --role-name vennir-$SA --assume-role-policy-document file://trust-$SA.json
   aws iam put-role-policy --role-name vennir-$SA --policy-name actions --policy-document file://s3-bucket.json   # its actions, as above
   ```

3. **Run `whoami`** with the role's ARN. Its failures name what's missing: `NO_TOKEN` (the step got no token), `TOKEN_NOT_TRUSTED` (no provider for the issuer, or AWS can't fetch its keys), `ROLE_NOT_ALLOWED` (the role's trust policy). Its check says which issuer and subject the role must trust.

`s3-bucket`, `ecs-express` and `rds-postgres` work the same way off EKS, each as its own role. With no default credentials (no Pod Identity), a product assumes the role a team secret named after its ServiceAccount holds (`aws-s3-bucket-role`, `aws-ecs-express-role`, `aws-rds-postgres-role`, key `role-arn`) by web identity, with its step's own token. So each of those roles trusts the cluster for exactly its product's ServiceAccount (`system:serviceaccount:<team>:aws-s3-bucket`, and so on), with that product's permissions above. A team maintainer registers each secret (the team's page → **Secrets**, or `SecretService/PutSecret`).

Uncomment the role's `secretRefs` line on **every** action in each `product.yaml` (`create`, `delete` and `check`; the samples have the lines, commented; where an action already lists a secret, as `ecs-express`'s `create` and `check` do, the role is a commented entry in that list). A template's steps, a run from the **Catalog** and **Delete** in **What runs made** each get their action's own `secretRefs`, never the caller's, so without the line on `create` and `delete` those runs have no role and fail. Only a hand-written DAG can give a step a secret its action doesn't list. `aws-target` means what it does on EKS: a second role, assumed as the product's own. On EKS nothing changes.

**The region off EKS.** A check asks in the cluster's AWS region, and a cluster outside AWS has none, so the samples' checks ask in us-east-1. If your organization's service control policies deny us-east-1, a check says **Not ready** and names an action for the product's role, though the role isn't what's refusing it. The actions themselves use each run's `region` input, so runs work: see what AWS says with `aws <service> <read call> --region us-east-1` as an account admin.

**App Runner is closed to new accounts.** AWS lets no new account create App Runner services ("Account … can't create new App Runner services"); the `app-runner` sample gave way to `ecs-express` (2026-11-07). A catalog that copied `app-runner` can't just delete it: its CI refuses a product removed without being deprecated first, so set `deprecated:` on it, merge, then remove it in a later pull request.

Proven from GKE (2026-11-07, from the 0.13.2 release): a team maintainer registered `aws-s3-bucket-role` and `aws-app-runner-role`; both checks signed in as their own roles (`s3-bucket` **Ready**); a member's template run made a bucket, tagged for its team with public access blocked, and started the then `app-runner` sample with its region resolved from the bucket's output; and **Delete** removed the bucket, each step signing in as its own ServiceAccount (CloudTrail: the sessions `vennir-check` and `vennir-step` on `vennir-aws-s3-bucket` and `vennir-aws-app-runner`). Your own products follow `caller-identity`: the same `tokenAudiences`, the same call.

**On kind**: AWS can't fetch the keys of kind's issuer, so there's no keyless way in. Use kind for products that call no cloud, and an EKS install for AWS.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| **Not ready**: no IAM role | No Pod Identity association for the product's ServiceAccount | Step 3 |
| `AccessDenied` naming an action | The role lacks it | Add it to the role's policy (step 2) |
| `AccessDenied` for `s3:TagResource` | A role granted from an older copy of the sample's table | Add `s3:TagResource` |
| `BUCKET_NAME_TAKEN` | Bucket names are global: another account has it | Pick another name |
| RDS refuses the create right after its service-linked role was made | AWS needs a moment | The step is retried, and goes through |
| `NOT_MADE_BY_VENNIR`, `NOT_THIS_TEAMS` | Not made by this team through Vennir (or before teams were tagged, 2026-11-03) | Delete it outside Vennir, or tag it `vennir-team=<team>` (an S3 tag set replaces every tag: give `vennir-made=true` again too) |
| `NOT_FOR_THIS_INSTALL` | The product's `clouds` names another cloud | Run it on an AWS install |
| Off EKS, a template's or **Delete**'s step can't sign in, though a hand-written DAG's can | The action in `product.yaml` doesn't list the role's secret | Uncomment `secretRefs` on every action, not only `check` |
| Off EKS, **Not ready** for an action the role allows | The check asks in us-east-1, which an organization policy denies | Check it as an admin in us-east-1; runs use their own `region` |
| "Account … can't create new App Runner services" | AWS no longer lets new accounts create App Runner services | Use `ecs-express` |
| `ecs-express`: "Unable to assume the service linked role" | The account has no ECS service-linked role yet, or the team's roles were made a moment ago | `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com`; otherwise the step is retried |
| `IMAGE_OUTSIDE_REGISTRY` | The image isn't under the `ecs-express` secret's `image-registry` | Push it there, or change the secret |
| `TASK_TIMEOUT` on a database | The default five minutes ran out | Raise `timeoutSeconds` |
| A target refuses connections from the cluster | It allows only known addresses | [Addresses and firewall rules](22-addresses-and-firewalls.md) |
