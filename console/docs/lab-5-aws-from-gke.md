# Lab 5: AWS from a GKE install

**Goal:** let products on your GKE install create AWS resources (an S3 bucket and an ECS Express service) with no AWS cluster and no key: each product assumes an IAM role of its own with its step's own token. **Time:** about an hour. **Cost:** billed, but small: a bucket, and an ECS Express service (a Fargate task and its load balancer, about $0.05 an hour) while it runs. **You need:** [Lab 3](lab-3-gke.md)'s install; an AWS account with the CLI signed in as someone who may create IAM roles ([Getting AWS ready](clouds-aws.md)).

The reasons behind each step are in [Deploy to AWS](20-deploy-to-aws.md#from-an-install-that-isnt-on-eks) and [Creating resources in every cloud](24-every-cloud-from-any-install.md#aws). Proven exactly this way on 2026-11-09, from the 0.15.0 release.

In zsh (macOS's shell), keep the braces in `${VAR}:sub` below: `$VAR:sub` is read as a modifier, and IAM then refuses the policy.

## 1. Put the products in a team

In your catalog repository: `cp -R samples/aws teams/aws`, then remove what this lab doesn't use (`teams/aws/products/rds-postgres`, `teams/aws/apis`, `teams/aws/secret-stores`). In every `product.yaml` left, uncomment each `secretRefs` line naming `<serviceAccount>-role` (on `create`, `delete` and `check`; in `ecs-express`, the commented entries in its lists): a template's steps, the Catalog's runs and Delete get only what their action lists. Add `/teams/aws/ @<you>` to `.github/CODEOWNERS`, open a pull request, merge it once CI passes, and add yourself to `aws` in the console.

## 2. Trust the cluster's tokens

```bash
export AWS_PROFILE=<your profile>
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
HOST=container.googleapis.com/v1/projects/<project>/locations/us-east1/clusters/vennir-lab   # GKE's issuer, without https://
aws iam create-open-id-connect-provider --url "https://${HOST}" --client-id-list sts.amazonaws.com
```

Once per account and cluster: AWS now accepts tokens this cluster signs, for the audience `sts.amazonaws.com`.

## 3. A role for each product

```bash
trust() { printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::%s:oidc-provider/%s"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"%s:sub":"system:serviceaccount:aws:%s","%s:aud":"sts.amazonaws.com"}}}]}' "${ACCOUNT}" "${HOST}" "${HOST}" "$1" "${HOST}"; }
for SA in aws-caller-identity aws-s3-bucket aws-ecs-express; do
  aws iam create-role --role-name $SA --assume-role-policy-document "$(trust $SA)"
done
aws iam put-role-policy --role-name aws-s3-bucket --policy-name s3-bucket --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:CreateBucket","s3:PutBucketPublicAccessBlock","s3:TagResource","s3:GetBucketTagging","s3:DeleteBucket"],"Resource":"arn:aws:s3:::vennir-lab-*"}]}'
```

Each role trusts exactly one ServiceAccount, in the `aws` team's namespace, on this cluster. `aws-caller-identity` needs no permissions: it only asks who it is. `aws-s3-bucket` may touch only buckets named `vennir-lab-*`.

For `ecs-express`, the roles a service runs with, ECS's own role, and its role's policy are in the aws sample's README (Hosting an app): make `aws-ecs-execution` and `aws-ecs-infrastructure`, run `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com`, and put the README's policy on `aws-ecs-express` with your account in it. Then make the repository its images come from: `aws ecr create-repository --repository-name aws/greetings --region us-east-2`.

## 4. Tell each step which role it is

As a maintainer of `aws`, on **Teams → aws → Secrets → Add a secret → Paste it here** (or `SecretService/PutSecret`):

| Secret | Keys |
| --- | --- |
| `aws-s3-bucket-role` | `role-arn`: `arn:aws:iam::<account>:role/aws-s3-bucket` |
| `aws-ecs-express-role` | `role-arn`: `arn:aws:iam::<account>:role/aws-ecs-express` |
| `ecs-express` | `image-registry`: `<account>.dkr.ecr.us-east-2.amazonaws.com/aws`; `execution-role-arn` and `infrastructure-role-arn`: the two roles' ARNs |

None of these is a credential: a role's ARN is useless without a token the role trusts.

## 5. Who am I?

**Catalog → caller-identity.whoami → Run**, for `aws`, with `roleArn: arn:aws:iam::<account>:role/aws-caller-identity`.

**Check:** its output names your account and `assumed-role/aws-caller-identity/…`, never a credential. Its failures say what's missing: `TOKEN_NOT_TRUSTED` (step 2), `ROLE_NOT_ALLOWED` (the role's trust).

## 6. A bucket, made and deleted

**Catalog → s3-bucket.create → Run**, for `aws`: `bucketName: vennir-lab-<something unique>`, `region: us-east-2`.

**Check:** the bucket exists with public access blocked and the tags `vennir-made=true`, `vennir-team=aws`. Then **Runs → What runs made → Delete** it: the product's `delete` runs, as its own role, and removes it.

## 7. An app on ECS Express

Build the greetings backend and push it under the team's registry:

```bash
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com
docker buildx build --platform linux/amd64 -t ${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/aws/greetings:1 --push examples/greetings-api
```

**Catalog → greetings-backend → Run**, for `aws`, with that image and `gatewayKeys: https://<the gateway's public host>/.vennir/jwks.json` ([Lab 7](lab-7-apis-across-clouds.md) puts the gateway on the internet; any https URL of that form works for this step).

**Check:** in about five minutes the `service` step outputs `serviceUrl`, `https://<id>.ecs.us-east-2.on.aws`. Called directly, the backend answers 401: it accepts only requests the gateway signed. Through the API instead of the form, give every parameter, `serviceName` included: only the form fills in a template's defaults for now.

## Clean up

Delete the service from **What runs made** (its run's **Delete**) or `aws ecs delete-express-gateway-service --service-arn <its ARN> --region us-east-2`; then the repository (`aws ecr delete-repository --repository-name aws/greetings --region us-east-2 --force`), the service's log group (`/aws/ecs/default/greetings-…`), the five roles (their inline policies first), and the OIDC provider. Keep them if you'll do Lab 7.

## What you proved

A product on GKE acting in AWS as a role of its own, by web identity, with nothing stored anywhere; roles scoped to one ServiceAccount and to the resources a product may touch; and deletes through Vennir.

**Next:** [Lab 6: Azure from a GKE install](lab-6-azure-from-gke.md).
