# Deploy to AWS from Vennir

This guide gets a team's products creating real resources in AWS: S3 buckets, App Runner services, RDS for PostgreSQL databases. It's for the team that owns the products and whoever administers IAM in the accounts they'll change. It follows the catalog's `samples/aws` products, which are tested on EKS; your own products work the same way.

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
| `app-runner` | `apprunner:ListServices`, `apprunner:DescribeService`, `apprunner:CreateService`, `apprunner:TagResource`, `apprunner:ListTagsForResource`, `apprunner:DeleteService`; `iam:PassRole` on the ECR access role, if its images are in a private ECR repository |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, `rds:DeleteDBInstance`, `rds:CreateDBSnapshot`; `secretsmanager:CreateSecret`, `secretsmanager:TagResource`, `secretsmanager:DeleteSecret`, `kms:DescribeKey` (RDS keeps the database's password in Secrets Manager; the step never sees it) |

The first App Runner service or RDS instance in an account also needs that service's service-linked role. Make it once yourself:

```bash
aws iam create-service-linked-role --aws-service-name apprunner.amazonaws.com
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
| `app-runner` | `apprunner:ListServices` | That action, for its role |
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
- App Runner and RDS finish an accepted delete on their own; the step doesn't wait.

## Writing your own AWS product

Start from the closest sample and keep what makes it safe: a `serviceAccount` of its own with a role that allows only its calls (the SDK's default credential chain finds it); a readiness check making the read-only calls its actions need; look before you create; tag what you make with `vennir-made` and `vennir-team` (the request's `forTeam`), report it in `resources`, and give it a `cleanup` action that deletes only what carries both; never return a credential in `result.json`. Every field is in [the catalog guide](catalog-guide.md#productyaml).

## From an install that isn't on EKS

**On GKE, or any cluster whose token issuer is public**, AWS can trust a product's own token, with no key: the `caller-identity` sample does exactly this. Its `product.yaml` declares `tokenAudiences: [sts.amazonaws.com]`, so each step gets an hour-long token for its own ServiceAccount at `/platform/tokens/sts.amazonaws.com`, and hands it to STS's `AssumeRoleWithWebIdentity`.

1. **The cluster's issuer** (on GKE it's `https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>`):

   ```bash
   ISSUER=$(kubectl get --raw /.well-known/openid-configuration | jq -r .issuer)
   aws iam create-open-id-connect-provider --url "$ISSUER" --client-id-list sts.amazonaws.com
   ```

2. **A role per product**, trusting that provider for exactly its ServiceAccount:

   ```json
   {
     "Effect": "Allow",
     "Principal": {"Federated": "arn:aws:iam::<account>:oidc-provider/<issuer without https://>"},
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {"StringEquals": {
       "<issuer without https://>:sub": "system:serviceaccount:web:web-caller-identity",
       "<issuer without https://>:aud": "sts.amazonaws.com"
     }}
   }
   ```

3. **Run `whoami`** with the role's ARN. Its failures name what's missing: `NO_TOKEN` (the step got no token), `TOKEN_NOT_TRUSTED` (no provider for the issuer, or AWS can't fetch its keys), `ROLE_NOT_ALLOWED` (the role's trust policy). Its check says which issuer and subject the role must trust.

`s3-bucket` works the same way off EKS: it declares the same `tokenAudiences`, and with no default credentials (no Pod Identity) it assumes the team's `aws-target` role (the secret `aws-target`, key `role-arn`, in the step's `secretRefs`) by web identity, so that role is the one trusting the cluster for `system:serviceaccount:<team>:aws-s3-bucket`, with the S3 permissions above. On EKS it's unchanged.

Proven on GKE (2026-11-07): `s3-bucket` made a bucket in an AWS account with no AWS cluster, tagged for its team with public access blocked, and its `delete` removed it, each step signing in as its own ServiceAccount (CloudTrail: the session `vennir-step` on the `aws-target` role). Your own products follow `caller-identity`: the same `tokenAudiences`, the same call.

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
| `TASK_TIMEOUT` on a database | The default five minutes ran out | Raise `timeoutSeconds` |
| A target refuses connections from the cluster | It allows only known addresses | [Addresses and firewall rules](22-addresses-and-firewalls.md) |
